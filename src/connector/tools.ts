// The tools Claude sees when it connects to Tecxbot.
//
// Design rule: every tool is read-only. The connector's job is to hand Claude
// the context of what clients have actually said on LINE and WhatsApp — it does
// not send, reply, or change anything on the operator's behalf.

import {
  getConversation,
  getMessages,
  getStats,
  listConversations,
  searchMessages,
  storeBackend,
  isCaptureEnabled,
  type ConnectorPlatform,
  type ConversationSummary,
  type StoredMessage,
} from '../core/conversationStore.js';
import { listConnectorChannels } from '../core/tenantStore.js';
import { fetchMediaBytes } from './media.js';
import { isR2Configured } from '../core/r2.js';
import { isReplyEnabled, isReviewMode, monthlyCap, replyAllowlist, replyQuota, reviewConversationId, sendLineReply, type ReplyOutcome, type ReplyReason } from './reply.js';
import { decideFileRendering, fileNameFromPlaceholder } from './fileKind.js';
import { looksLikeZip, parseZip } from './zip.js';
import { getNote, isNoteStoreDurable, listNotes, saveNote, searchNotes, updateNote, type Note } from '../core/noteStore.js';

// A tool normally returns text; `content` lets it return richer MCP blocks
// (e.g. an image), which the server uses in place of the wrapped text.
export type ToolContentBlock = { type: string; [key: string]: unknown };
export type ToolOutput = { text: string; structured: Record<string, unknown>; content?: ToolContentBlock[] };

export type ToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOutput>;
  // Most tools are read-only; a tool that writes (e.g. send_line_reply) sets its
  // own annotations. Default is applied in toolListPayload.
  annotations?: ToolAnnotations;
  // A tool can be gated off at runtime by env. When this returns false the tool
  // is not advertised in tools/list (it stays callable so an explicit call gets
  // a helpful "how to enable" message rather than "unknown tool").
  enabled?: () => boolean;
};

// Inlining an image as base64 inflates the JSON-RPC response ~1.33x, and the
// model has to ingest all of it — so cap what get_image will return.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_FILE_BYTES = 512 * 1024;
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'file']);

const PLATFORM_ENUM = ['line', 'whatsapp'];

const platformProperty = {
  type: 'string',
  enum: PLATFORM_ENUM,
  description: 'Restrict to one messaging platform. Omit for both.',
};

const sinceProperty = {
  type: 'string',
  description: 'How far back to look: a relative window like "24h", "7d", "2w", an ISO date like "2026-08-01", or "all".',
};

const tenantProperty = {
  type: 'string',
  description: 'Optional tenant id, for deployments hosting more than one business. Ignored when the deployment is pinned to a single tenant.',
};

// When CONNECTOR_TENANT_ID is set, the deployment is pinned to one tenant and
// the caller-supplied tenant_id is ignored — so a token on a shared database
// cannot read another tenant's conversations by asking for a different id.
// Unset (the common single-owner case) leaves the caller's value untouched.
function enforcedTenant(argValue: unknown): string | undefined {
  const pinned = process.env.CONNECTOR_TENANT_ID?.trim();
  if (pinned) return pinned;
  return readString(argValue);
}

export const connectorTools: ToolDefinition[] = [
  {
    name: 'latest_context',
    title: 'Latest client context',
    description:
      'Load the most recent client conversations from LINE and WhatsApp, with their latest messages, as ready-to-read session context. Use this first when the user refers to "my clients", "the latest chat", or asks what a client said, so the answer is grounded in the real conversation instead of assumptions.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: platformProperty,
        conversations: { type: 'integer', minimum: 1, maximum: 20, description: 'How many recent conversations to include. Default 5.' },
        messages_per_conversation: { type: 'integer', minimum: 1, maximum: 100, description: 'Messages to include per conversation, newest last. Default 20.' },
        since: sinceProperty,
        tenant_id: tenantProperty,
      },
      additionalProperties: false,
    },
    async handler(args) {
      const platform = readPlatform(args.platform);
      const tenantId = enforcedTenant(args.tenant_id);
      const since = parseSince(readString(args.since), '7d');
      const conversationLimit = readInt(args.conversations, 5, 1, 20);
      const perConversation = readInt(args.messages_per_conversation, 20, 1, 100);

      const conversations = await listConversations({ tenantId, platform, since, limit: conversationLimit });
      if (!conversations.length) return emptyResult(since, platform);

      // Deliberately fetched without the `since` filter: if a client went quiet
      // for a week, the last thing they said is still the context that matters.
      const blocks = await Promise.all(
        conversations.map(async (conversation) => ({
          conversation,
          messages: await getMessages({ conversationId: conversation.conversationId, tenantId, limit: perConversation }),
        })),
      );

      const heading = `# Latest client context — ${blocks.length} conversation${blocks.length === 1 ? '' : 's'}${since ? ` active since ${formatTimestamp(since)}` : ''}`;
      const text = [heading, warningLine(), ...blocks.map((block) => renderConversationBlock(block.conversation, block.messages))]
        .filter(Boolean)
        .join('\n\n');

      return {
        text,
        structured: {
          generatedAt: new Date().toISOString(),
          storage: storeBackend(),
          since: since ? new Date(since).toISOString() : null,
          conversations: blocks.map((block) => ({
            ...serializeConversation(block.conversation),
            messages: block.messages.map(serializeMessage),
          })),
        },
      };
    },
  },

  {
    name: 'list_conversations',
    title: 'List client conversations',
    description:
      'List captured client conversations (LINE groups, LINE 1:1 chats, WhatsApp threads) ordered by most recent activity, with a one-line preview of the last message. Use it to find which conversation to open, then call get_conversation for the full transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        platform: platformProperty,
        query: { type: 'string', description: 'Substring match against the conversation name (group name or contact name).' },
        since: sinceProperty,
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum conversations to return. Default 20.' },
        tenant_id: tenantProperty,
      },
      additionalProperties: false,
    },
    async handler(args) {
      const platform = readPlatform(args.platform);
      const conversations = await listConversations({
        tenantId: enforcedTenant(args.tenant_id),
        platform,
        since: parseSince(readString(args.since), '30d'),
        query: readString(args.query),
        limit: readInt(args.limit, 20, 1, 200),
      });
      if (!conversations.length) return emptyResult(undefined, platform);
      const lines = conversations.map((conversation) => {
        const preview = conversation.lastMessagePreview ? ` — ${conversation.lastDirection === 'outbound' ? '(bot) ' : ''}${conversation.lastMessagePreview}` : '';
        return `- ${conversationLabel(conversation)} · ${conversation.messageCount ?? 0} messages · last ${formatTimestamp(conversation.lastMessageAt)}\n  id: ${conversation.conversationId}${preview}`;
      });
      return {
        text: [`# Client conversations (${conversations.length})`, warningLine(), ...lines].filter(Boolean).join('\n'),
        structured: { conversations: conversations.map(serializeConversation) },
      };
    },
  },

  {
    name: 'get_conversation',
    title: 'Get a conversation transcript',
    description: 'Read the message history of one conversation in chronological order. Pass the conversation_id returned by latest_context, list_conversations, or search_messages.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'Conversation id, e.g. "line:tecxmate:group:C1234abcd".' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'How many of the most recent messages to return. Default 50.' },
        since: sinceProperty,
        tenant_id: tenantProperty,
      },
      required: ['conversation_id'],
      additionalProperties: false,
    },
    async handler(args) {
      const conversationId = readString(args.conversation_id);
      if (!conversationId) throw new Error('conversation_id is required.');
      const tenantId = enforcedTenant(args.tenant_id);
      const conversation = await getConversation(conversationId, tenantId);
      if (!conversation) {
        return {
          text: `No conversation found with id "${conversationId}". Call list_conversations to see the captured conversations.`,
          structured: { found: false, conversationId },
        };
      }
      const messages = await getMessages({
        conversationId,
        tenantId,
        since: parseSince(readString(args.since)),
        limit: readInt(args.limit, 50, 1, 1000),
      });
      return {
        text: renderConversationBlock(conversation, messages),
        structured: { found: true, ...serializeConversation(conversation), messages: messages.map(serializeMessage) },
      };
    },
  },

  {
    name: 'search_messages',
    title: 'Search client messages',
    description: 'Find client messages containing a phrase across every captured LINE and WhatsApp conversation. Use it to answer "when did they mention the invoice?" or to locate the thread before reading it in full.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for. Case-insensitive substring match.' },
        platform: platformProperty,
        conversation_id: { type: 'string', description: 'Restrict the search to one conversation.' },
        since: sinceProperty,
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum matches to return. Default 30.' },
        tenant_id: tenantProperty,
      },
      required: ['query'],
      additionalProperties: false,
    },
    async handler(args) {
      const query = readString(args.query);
      if (!query) throw new Error('query is required.');
      const matches = await searchMessages({
        query,
        tenantId: enforcedTenant(args.tenant_id),
        platform: readPlatform(args.platform),
        conversationId: readString(args.conversation_id),
        since: parseSince(readString(args.since)),
        limit: readInt(args.limit, 30, 1, 200),
      });
      if (!matches.length) {
        return { text: `No captured message matches "${query}".`, structured: { query, matches: [] } };
      }
      const lines = matches.map((message) => `- [${formatTimestamp(message.at)}] ${speaker(message)}: ${collapse(message.text)}\n  id: ${message.conversationId}`);
      return {
        text: [`# ${matches.length} match${matches.length === 1 ? '' : 'es'} for "${query}"`, ...lines].join('\n'),
        structured: { query, matches: matches.map(serializeMessage) },
      };
    },
  },

  {
    name: 'connector_status',
    title: 'Connector status',
    description: 'Report how the connector is wired up: storage backend, whether capture is on, which LINE and WhatsApp channels are configured, and how much history has been captured. Use it when a tool returns nothing to tell a setup problem apart from a genuinely quiet inbox.',
    inputSchema: { type: 'object', properties: { tenant_id: tenantProperty }, additionalProperties: false },
    async handler(args) {
      const stats = await getStats(enforcedTenant(args.tenant_id));
      const channels = listConnectorChannels();
      const quota = isReplyEnabled() ? await replyQuota() : { cap: monthlyCap(), used: 0 };
      const lines = [
        '# Tecxbot connector status',
        '',
        `storage: ${stats.backend}${stats.durable ? ' (durable)' : ' (in-memory — history is lost on every cold start)'}`,
        `capture: ${isCaptureEnabled() ? 'on' : 'off (CONNECTOR_CAPTURE=false)'}`,
        `replies: ${replyStatusLine()}`,
        ...(isReplyEnabled() && quota.cap ? [`reply pushes this month: ${quota.used} / ${quota.cap}`] : []),
        `media archival: ${isR2Configured() ? 'on (Cloudflare R2)' : 'off — media served live from LINE, recent only'}`,
        `conversations captured: ${stats.conversations}`,
        `messages captured: ${stats.messages}`,
        `last captured message: ${stats.lastMessageAt ? formatTimestamp(stats.lastMessageAt) : 'none yet'}`,
        '',
        'Configured channels:',
        ...(channels.length ? channels.map((channel) => `- ${channel.platform}: ${channel.id} (${channel.label})`) : ['- none — no messaging credentials are set']),
      ];
      if (stats.error) lines.push('', `storage error: ${stats.error}`);
      if (!stats.durable) lines.push('', 'To keep history across requests, set CONNECTOR_DATABASE_URL to a Postgres connection string.');
      return {
        text: lines.join('\n'),
        structured: {
          ...stats,
          capture: isCaptureEnabled(),
          replies: { enabled: isReplyEnabled(), mode: isReviewMode() ? 'review' : 'direct', reviewConversationId: reviewConversationId() ?? null, allowlist: replyAllowlist(), monthlyCap: quota.cap ?? null, pushesThisMonth: quota.used },
          mediaArchival: isR2Configured(),
          channels,
        },
      };
    },
  },

  {
    name: 'send_line_reply',
    title: 'Reply in a LINE conversation (as the PM)',
    description:
      'Reply to a LINE conversation as the TECXMATE project manager (PM), grounded in the conversation and in project status from Jira. Pass the CLIENT conversation_id you are answering. Behavior depends on deployment config: in direct mode it sends straight to that group (everyone sees it); in review/draft mode it instead posts the draft into an internal review group for a human to approve, and the client is never written to — connector_status shows which mode is active. Use it ONLY for a message that tags or is addressed to the PM. Do not invent dates, prices, or commitments; check Jira or say you will follow up. Available only when CONNECTOR_ALLOW_REPLY=true; otherwise the connector is read-only.',
    enabled: () => isReplyEnabled(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'The CLIENT conversation you are answering, e.g. "line:tecxmate:group:C1234abcd" (from latest_context / list_conversations). In review mode this is what the draft is labelled for, not where it is sent.' },
        text: { type: 'string', description: 'The reply, as the PM. Concise and professional. In direct mode it is sent verbatim to the group; in review mode it is the draft a human approves.' },
        tenant_id: tenantProperty,
      },
      required: ['conversation_id', 'text'],
      additionalProperties: false,
    },
    async handler(args) {
      const conversationId = readString(args.conversation_id);
      const text = readString(args.text);
      if (!conversationId) throw new Error('conversation_id is required.');
      if (!text) throw new Error('text is required.');
      const outcome = await sendLineReply({ conversationId, text, tenantId: enforcedTenant(args.tenant_id) });
      if (!outcome.ok) return replyError(outcome, conversationId);
      if (outcome.mode === 'review') {
        const confirmation = `Draft posted to the review group for approval — nothing was sent to the client. Drafted for ${conversationId} at ${formatTimestamp(outcome.at)}. A human approves and delivers it.`;
        return { text: confirmation, structured: { sent: false, drafted: true, mode: 'review', conversationId, reviewConversationId: outcome.reviewConversationId, at: new Date(outcome.at).toISOString() } };
      }
      const confirmation = `Sent to ${conversationId} at ${formatTimestamp(outcome.at)}.`;
      return { text: confirmation, structured: { sent: true, mode: 'direct', conversationId, to: outcome.to, at: new Date(outcome.at).toISOString() } };
    },
  },

  {
    name: 'get_image',
    title: 'View an image from a conversation',
    description:
      'Fetch and view an image message sent in a LINE conversation — by anyone in it, a client or the operator — so you can actually see it. Pass the conversation_id and the message\'s `mediaId` (shown on image messages in get_conversation / latest_context). The image is fetched live from LINE on demand — nothing is stored — so it works for recent images while LINE still retains the media.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'The conversation the image was sent in.' },
        message_id: { type: 'string', description: 'The image message\'s mediaId, from get_conversation / latest_context.' },
        tenant_id: tenantProperty,
      },
      required: ['conversation_id', 'message_id'],
      additionalProperties: false,
    },
    async handler(args) {
      const conversationId = readString(args.conversation_id);
      const messageId = readString(args.message_id);
      if (!conversationId || !messageId) throw new Error('conversation_id and message_id are required.');
      const tenantId = enforcedTenant(args.tenant_id);

      const located = await locateMedia(conversationId, messageId, tenantId);
      if ('error' in located) return imageError(located.error);
      const { conversation, target } = located;

      let media;
      try {
        media = await fetchMediaBytes(target);
      } catch (error) {
        return imageError(`Couldn't fetch that image — it may have expired from LINE and isn't archived. (${formatError(error)})`);
      }

      const bytes = media.content.byteLength;
      if (bytes > MAX_IMAGE_BYTES) return imageError(`That image is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB inline limit.`);
      if (!media.contentType.startsWith('image/')) return imageError(`That message is not an image (content type: ${media.contentType}). Try get_file instead.`);

      const base64 = Buffer.from(media.content).toString('base64');
      const caption = `Image from ${conversationLabel(conversation)}, sent by ${target.senderName || shortId(target.senderId) || 'client'} at ${formatTimestamp(target.at)}${media.source === 'r2' ? '' : ' (live from LINE)'}.`;
      return {
        text: caption,
        structured: { conversationId, messageId, mimeType: media.contentType, bytes, sentAt: new Date(target.at).toISOString(), source: media.source },
        content: [
          { type: 'text', text: caption },
          { type: 'image', data: base64, mimeType: media.contentType },
        ],
      };
    },
  },

  {
    name: 'get_file',
    title: 'Open a file from a conversation',
    description:
      'Fetch a non-image file a client sent on LINE (a document, PDF, text/CSV, code, or a .zip archive). Pass the conversation_id and the message\'s `mediaId`. Text-based files are returned as text you can read; a .zip is unzipped and the text files inside are returned; images are handled by get_image instead. Served from durable storage when archived, otherwise live from LINE while it still retains the media.',
    inputSchema: {
      type: 'object',
      properties: {
        conversation_id: { type: 'string', description: 'The conversation the file was sent in.' },
        message_id: { type: 'string', description: 'The file message\'s mediaId, from get_conversation / latest_context.' },
        tenant_id: tenantProperty,
      },
      required: ['conversation_id', 'message_id'],
      additionalProperties: false,
    },
    async handler(args) {
      const conversationId = readString(args.conversation_id);
      const messageId = readString(args.message_id);
      if (!conversationId || !messageId) throw new Error('conversation_id and message_id are required.');
      const located = await locateMedia(conversationId, messageId, enforcedTenant(args.tenant_id));
      if ('error' in located) return imageError(located.error);
      const { conversation, target } = located;

      let media;
      try {
        media = await fetchMediaBytes(target);
      } catch (error) {
        return imageError(`Couldn't fetch that file — it may have expired from LINE and isn't archived. (${formatError(error)})`);
      }

      const bytes = media.content.byteLength;
      // LINE serves files as application/octet-stream, so fall back to the
      // captured filename and a UTF-8 sniff to recover text (a .md/.csv/.txt spec
      // would otherwise read as opaque binary).
      const fileName = fileNameFromPlaceholder(target.text);
      const label = `File${fileName ? ` "${fileName}"` : ''} from ${conversationLabel(conversation)}, sent by ${target.senderName || shortId(target.senderId) || 'client'} at ${formatTimestamp(target.at)} · ${media.contentType} · ${(bytes / 1024).toFixed(0)} KB.`;
      const structured = { conversationId, messageId, fileName: fileName ?? null, mimeType: media.contentType, bytes, sentAt: new Date(target.at).toISOString(), source: media.source };

      // A zip: unzip in-memory and return the text files inside, rather than
      // reporting an opaque archive.
      if (looksLikeZip(media.content) || /\.zip$/i.test(fileName ?? '') || /zip/i.test(media.contentType)) {
        return renderArchive(media.content, fileName, label, structured);
      }

      const rendering = decideFileRendering({ contentType: media.contentType, fileName, content: media.content, maxTextBytes: MAX_TEXT_FILE_BYTES });
      if (rendering.kind === 'image') {
        const base64 = Buffer.from(media.content).toString('base64');
        return { text: label, structured, content: [{ type: 'text', text: label }, { type: 'image', data: base64, mimeType: media.contentType }] };
      }
      if (rendering.kind === 'text') {
        // Put the file's text in BOTH the wrapped text block and structuredContent:
        // the claude.ai connector surfaces structuredContent as the tool result, so
        // the content had to live there too, not only in the text block.
        return {
          text: `${label}\n\n${rendering.text}`,
          structured: { ...structured, textLength: rendering.text.length, text: rendering.text },
        };
      }
      // Binary the model can't read inline (a PDF, a zip, or a file over the inline
      // text cap). Report it rather than dumping base64 that no client renders.
      const why = rendering.reason === 'too_big' ? `it is ${(bytes / 1024).toFixed(0)} KB, over the ${MAX_TEXT_FILE_BYTES / 1024} KB inline-text limit` : 'it is not text';
      return { text: `${label}\n\nThis file can't be shown inline here (${why}). It is ${media.source === 'r2' ? 'archived durably' : 'still available live from LINE'}.`, structured };
    },
  },

  // ---- project memory: durable, taggable notes & transcripts ----

  {
    name: 'save_note',
    title: 'Save a note or transcript to project memory',
    description:
      'Save a note, meeting transcript, or decision into durable project memory (Neon Postgres), so it stays accessible across sessions and clients — independent of LINE. Tag it with what keeps the project organized: project, milestone, participants, free-form tags, and occurred_at (when the meeting/recording actually happened). Use this to file a transcript you were handed, or to record a decision. Returns the note id.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short title for the note.' },
        body: { type: 'string', description: 'The full text — the transcript, notes, or decision.' },
        project: { type: 'string', description: 'Which project this belongs to (free-form, e.g. "ogsmbooster").' },
        milestone: { type: 'string', description: 'The milestone/phase this belongs to (free-form).' },
        participants: { type: 'array', items: { type: 'string' }, description: 'Who was involved (names).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Free-form tags for retrieval.' },
        occurred_at: sinceProperty2('When the meeting/recording happened — a relative window like "2h" ago, an ISO date/time, or omit for now.'),
        source: { type: 'string', description: 'Where it came from, e.g. "transcript", "meeting", "note". Default "note".' },
        conversation_id: { type: 'string', description: 'Optional: link to a captured conversation this note relates to.' },
        tenant_id: tenantProperty,
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
    async handler(args) {
      const title = readString(args.title);
      const body = readString(args.body);
      if (!title || !body) throw new Error('title and body are required.');
      const note = await saveNote({
        tenantId: enforcedTenant(args.tenant_id) ?? DEFAULT_NOTE_TENANT,
        title,
        body,
        project: readString(args.project),
        milestone: readString(args.milestone),
        participants: readStringArray(args.participants),
        tags: readStringArray(args.tags),
        source: readString(args.source),
        conversationId: readString(args.conversation_id),
        occurredAt: parseWhen(readString(args.occurred_at)),
      });
      return { text: `Saved note ${note.id}: "${note.title}".${note.project ? ` project: ${note.project}` : ''}`, structured: { saved: true, ...serializeNote(note) } };
    },
  },

  {
    name: 'update_note',
    title: 'Tag or edit a note in project memory',
    description:
      'Update a saved note: set or change its project, milestone, participants, tags, title, occurred_at, or body. Pass note_id and only the fields to change. Use add_tags / add_participants to append without replacing. This is how you keep project memory organized over time.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'The id from save_note / list_notes.' },
        title: { type: 'string' },
        body: { type: 'string' },
        project: { type: 'string' },
        milestone: { type: 'string' },
        participants: { type: 'array', items: { type: 'string' }, description: 'Replace the participant list.' },
        add_participants: { type: 'array', items: { type: 'string' }, description: 'Append participants without replacing.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Replace the tag list.' },
        add_tags: { type: 'array', items: { type: 'string' }, description: 'Append tags without replacing.' },
        occurred_at: sinceProperty2('When the meeting/recording happened — relative, ISO date/time, or omit to leave unchanged.'),
        tenant_id: tenantProperty,
      },
      required: ['note_id'],
      additionalProperties: false,
    },
    async handler(args) {
      const id = readString(args.note_id);
      if (!id) throw new Error('note_id is required.');
      const updated = await updateNote(id, {
        tenantId: enforcedTenant(args.tenant_id),
        title: readString(args.title),
        body: typeof args.body === 'string' ? args.body : undefined,
        project: args.project !== undefined ? (readString(args.project) ?? '') : undefined,
        milestone: args.milestone !== undefined ? (readString(args.milestone) ?? '') : undefined,
        participants: args.participants !== undefined ? readStringArray(args.participants) : undefined,
        addParticipants: readStringArray(args.add_participants),
        tags: args.tags !== undefined ? readStringArray(args.tags) : undefined,
        addTags: readStringArray(args.add_tags),
        occurredAt: args.occurred_at !== undefined ? parseWhen(readString(args.occurred_at)) : undefined,
      });
      if (!updated) return { text: `No note found with id "${id}".`, structured: { updated: false, noteId: id } };
      return { text: `Updated note ${updated.id}.`, structured: { updated: true, ...serializeNote(updated) } };
    },
  },

  {
    name: 'list_notes',
    title: 'List project-memory notes',
    description: 'Browse saved notes and transcripts, newest first (by when they occurred). Filter by project, milestone, tag, participant, or a time window. Use it to pull the context for a project or milestone.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Only notes in this project.' },
        milestone: { type: 'string', description: 'Only notes in this milestone.' },
        tag: { type: 'string', description: 'Only notes carrying this tag.' },
        participant: { type: 'string', description: 'Only notes involving this participant (substring match).' },
        since: sinceProperty,
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum notes to return. Default 25.' },
        tenant_id: tenantProperty,
      },
      additionalProperties: false,
    },
    async handler(args) {
      const notes = await listNotes({
        tenantId: enforcedTenant(args.tenant_id),
        project: readString(args.project),
        milestone: readString(args.milestone),
        tag: readString(args.tag),
        participant: readString(args.participant),
        since: parseSince(readString(args.since)),
        limit: readInt(args.limit, 25, 1, 200),
      });
      if (!notes.length) return { text: notesEmptyText(), structured: { notes: [] } };
      const lines = notes.map((note) => `- ${note.title}${note.project ? ` · ${note.project}` : ''}${note.milestone ? ` / ${note.milestone}` : ''} · ${formatTimestamp(note.occurredAt ?? note.createdAt)}\n  id: ${note.id}${note.tags.length ? ` · tags: ${note.tags.join(', ')}` : ''}`);
      return { text: [`# Project-memory notes (${notes.length})`, notesBackendLine(), ...lines].filter(Boolean).join('\n'), structured: { notes: notes.map(serializeNote) } };
    },
  },

  {
    name: 'search_notes',
    title: 'Search project-memory notes',
    description: 'Find saved notes and transcripts whose title or body contains a phrase. Use it to answer "what did we decide about X?" from project memory.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to look for (case-insensitive).' },
        project: { type: 'string', description: 'Restrict to one project.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum matches. Default 25.' },
        tenant_id: tenantProperty,
      },
      required: ['query'],
      additionalProperties: false,
    },
    async handler(args) {
      const query = readString(args.query);
      if (!query) throw new Error('query is required.');
      const notes = await searchNotes({ query, tenantId: enforcedTenant(args.tenant_id), project: readString(args.project), limit: readInt(args.limit, 25, 1, 200) });
      if (!notes.length) return { text: `No note matches "${query}".`, structured: { query, notes: [] } };
      const lines = notes.map((note) => `- ${note.title}${note.project ? ` · ${note.project}` : ''} · ${formatTimestamp(note.occurredAt ?? note.createdAt)}\n  id: ${note.id} — ${collapse(note.body)}`);
      return { text: [`# ${notes.length} note match${notes.length === 1 ? '' : 'es'} for "${query}"`, ...lines].join('\n'), structured: { query, notes: notes.map(serializeNote) } };
    },
  },

  {
    name: 'get_note',
    title: 'Read a project-memory note',
    description: 'Read one saved note or transcript in full, with its tags and metadata. Pass the note_id from list_notes / search_notes.',
    inputSchema: {
      type: 'object',
      properties: { note_id: { type: 'string' }, tenant_id: tenantProperty },
      required: ['note_id'],
      additionalProperties: false,
    },
    async handler(args) {
      const id = readString(args.note_id);
      if (!id) throw new Error('note_id is required.');
      const note = await getNote(id, enforcedTenant(args.tenant_id));
      if (!note) return { text: `No note found with id "${id}".`, structured: { found: false, noteId: id } };
      const meta = [
        `# ${note.title}`,
        `id: ${note.id}`,
        note.project ? `project: ${note.project}` : '',
        note.milestone ? `milestone: ${note.milestone}` : '',
        note.participants.length ? `participants: ${note.participants.join(', ')}` : '',
        note.tags.length ? `tags: ${note.tags.join(', ')}` : '',
        `occurred: ${formatTimestamp(note.occurredAt ?? note.createdAt)}`,
        `source: ${note.source}`,
      ].filter(Boolean).join('\n');
      return { text: `${meta}\n\n${note.body}`, structured: { found: true, ...serializeNote(note) } };
    },
  },

  {
    name: 'project_status',
    title: 'Where a project stands',
    description:
      'Assemble everything project memory knows about one project in a single call: its living brief, open (not-done) reminders with due dates, recent decisions, and the latest notes. Use this when asked where a project stands, to catch up on one, or before answering as the PM — it is the fastest way to load a project\'s context, and it follows the memory conventions so every teammate sees the same picture. Omit "project" to list the projects that exist.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'The project name, as used when notes were tagged (e.g. "ogsmbooster"). Omit to list known projects.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many recent notes to include. Default 10.' },
        tenant_id: tenantProperty,
      },
      additionalProperties: false,
    },
    async handler(args) {
      const tenantId = enforcedTenant(args.tenant_id);
      const project = readString(args.project);
      const limit = readInt(args.limit, 10, 1, 50);

      // No project named: enumerate what exists, so the caller can pick one.
      if (!project) {
        const all = await listNotes({ tenantId, limit: 200 });
        const projects = [...new Set(all.map((note) => note.project).filter((p): p is string => Boolean(p)))].sort();
        if (!projects.length) return { text: `${notesEmptyText()}\n\nNo notes carry a project yet — tag them with a project to group them.`, structured: { projects: [] } };
        return {
          text: [`# Projects (${projects.length})`, notesBackendLine(), ...projects.map((p) => `- ${p}`), '', 'Call project_status with one of these to load its context.'].filter(Boolean).join('\n'),
          structured: { projects },
        };
      }

      const [brief, reminders, decisions, recent] = await Promise.all([
        // The living brief is a note titled "<project> — brief" by convention.
        listNotes({ tenantId, project, limit: 50 }),
        listNotes({ tenantId, project, tag: 'reminder', limit: 100 }),
        listNotes({ tenantId, project, tag: 'decision', limit: 10 }),
        listNotes({ tenantId, project, limit }),
      ]);

      const briefNote = brief.find((note) => /—\s*brief\s*$/i.test(note.title.trim()) || /\bbrief\b/i.test(note.title));
      // Open reminders only, and only ones with a real due date (see the daily brief).
      const open = reminders
        .filter((note) => !note.tags.includes('done') && note.occurredAt !== undefined)
        .sort((a, b) => (a.occurredAt ?? 0) - (b.occurredAt ?? 0));
      const jiraKeys = [...new Set(brief.flatMap((note) => note.tags).filter((tag) => /^[A-Z][A-Z0-9]+-\d+$/.test(tag)))];

      if (!brief.length) {
        return { text: `No notes found for project "${project}".${notesBackendLine() ? `\n${notesBackendLine()}` : ''}`, structured: { project, found: false } };
      }

      const now = Date.now();
      const sections = [`# ${project}`, notesBackendLine(), ''].filter(Boolean);
      sections.push('## Brief');
      sections.push(briefNote ? `${briefNote.body}\n\n(note ${briefNote.id} — update it in place with update_note)` : 'No living brief yet. Create one: a note titled "' + project + ' — brief" holding the current state.');
      sections.push('', `## Open reminders (${open.length})`);
      sections.push(open.length
        ? open.map((note) => `- ${(note.occurredAt ?? 0) < now ? '⚠️ overdue' : 'due'} ${formatTimestamp(note.occurredAt ?? note.createdAt)} — ${note.title}\n  id: ${note.id}`).join('\n')
        : '- none');
      sections.push('', `## Recent decisions (${decisions.length})`);
      sections.push(decisions.length
        ? decisions.map((note) => `- ${note.title} · ${formatTimestamp(note.occurredAt ?? note.createdAt)}\n  id: ${note.id} — ${collapse(note.body)}`).join('\n')
        : '- none tagged "decision" yet');
      sections.push('', `## Latest notes (${recent.length})`);
      sections.push(recent.length
        ? recent.map((note) => `- ${note.title}${note.milestone ? ` / ${note.milestone}` : ''} · ${formatTimestamp(note.occurredAt ?? note.createdAt)}\n  id: ${note.id}`).join('\n')
        : '- none');
      if (jiraKeys.length) sections.push('', `## Linked Jira issues`, jiraKeys.map((key) => `- ${key}`).join('\n'));

      return {
        text: sections.join('\n'),
        structured: {
          project,
          found: true,
          brief: briefNote ? serializeNote(briefNote) : null,
          openReminders: open.map(serializeNote),
          decisions: decisions.map(serializeNote),
          recentNotes: recent.map(serializeNote),
          jiraKeys,
        },
      };
    },
  },
];

function imageError(message: string): ToolOutput {
  return { text: message, structured: { error: message } };
}

// Unzip a fetched archive and render the text files inside. Text content goes in
// both the text block and structuredContent (the connector surfaces the latter).
// Bounded against zip bombs by parseZip and by an inline text budget here.
function renderArchive(content: ArrayBuffer, fileName: string | undefined, label: string, structured: Record<string, unknown>): ToolOutput {
  let entries;
  try {
    entries = parseZip(content);
  } catch (error) {
    const message = `Couldn't read this zip: ${formatError(error)}.`;
    return { text: `${label}\n\n${message}`, structured: { ...structured, archive: { error: formatError(error) } } };
  }

  const files = entries.filter((entry) => !entry.isDir);
  if (!files.length) return { text: `${label}\n\nThe archive is empty.`, structured: { ...structured, archive: { fileCount: 0, entries: [] } } };

  const listing = files.map((entry) => `- ${entry.name} (${(entry.content.byteLength / 1024).toFixed(1)} KB)`);
  const sections: string[] = [];
  const archiveEntries: Array<Record<string, unknown>> = [];
  let budget = MAX_TEXT_FILE_BYTES;

  for (const entry of files) {
    if (budget <= 0) { sections.push('----- (remaining files omitted — inline text budget reached; ask for a specific file) -----'); break; }
    const rendering = decideFileRendering({ contentType: '', fileName: entry.name, content: entry.content, maxTextBytes: Math.min(budget, 256 * 1024) });
    if (rendering.kind === 'text') {
      sections.push(`----- ${entry.name} -----\n${rendering.text}`);
      archiveEntries.push({ name: entry.name, bytes: entry.content.byteLength, kind: 'text', text: rendering.text });
      budget -= rendering.text.length;
    } else {
      const note = rendering.kind === 'image' ? 'image, not shown' : rendering.reason === 'too_big' ? 'too large to show inline' : 'binary, not shown';
      sections.push(`----- ${entry.name} — ${note} -----`);
      archiveEntries.push({ name: entry.name, bytes: entry.content.byteLength, kind: rendering.kind === 'image' ? 'image' : 'binary' });
    }
  }

  const heading = `Archive ${fileName ? `"${fileName}" ` : ''}— ${files.length} file${files.length === 1 ? '' : 's'}:`;
  const body = [heading, ...listing, '', ...sections].join('\n');
  return { text: `${label}\n\n${body}`, structured: { ...structured, archive: { fileCount: files.length, entries: archiveEntries } } };
}

function replyStatusLine(): string {
  if (!isReplyEnabled()) return 'off (read-only — set CONNECTOR_ALLOW_REPLY=true to let the PM reply)';
  const cap = monthlyCap();
  const capNote = cap ? ` · monthly push cap ${cap}` : '';
  if (isReviewMode()) return `review mode — drafts go to ${reviewConversationId()} for approval; the client is never written to${capNote}`;
  const allow = replyAllowlist();
  const scope = allow.length ? `restricted to ${allow.length} conversation${allow.length === 1 ? '' : 's'}` : 'any LINE conversation';
  return `on, direct send — ${scope}${capNote}`;
}

function replyError(outcome: Extract<ReplyOutcome, { ok: false }>, conversationId: string): ToolOutput {
  const reason: ReplyReason = outcome.reason;
  const message = {
    disabled: 'Replying is turned off on this deployment. Set CONNECTOR_ALLOW_REPLY=true to let the PM post to LINE.',
    empty: 'Nothing to send — the reply text was empty.',
    not_found: `No conversation found with id "${conversationId}". Call list_conversations to see the captured conversations.`,
    not_line: 'Only LINE conversations can be replied to — WhatsApp is capture-only here.',
    not_allowed: `Replying to "${conversationId}" isn't allowed. Add it to CONNECTOR_REPLY_CONVERSATION_IDS, or clear that list to allow any LINE conversation.`,
    no_token: 'The LINE channel for this conversation has no access token configured, so the reply can\'t be sent.',
    review_not_found: `Review mode is on, but the review group "${reviewConversationId()}" hasn't been captured yet. Make sure the bot is in that group and one message has been seen, then try again.`,
    review_not_line: 'The configured review conversation must be a LINE conversation.',
    review_no_token: 'The LINE channel for the review group has no access token configured, so the draft can\'t be posted.',
    over_cap: `Monthly LINE push cap reached (${outcome.used ?? '?'} of ${outcome.cap ?? '?'} used this month), so nothing was sent — this protects the LINE quota. It resets at the start of next month, or raise CONNECTOR_REPLY_MONTHLY_CAP. Present the draft in chat for a human to send instead.`,
  }[reason];
  return { text: message, structured: { sent: false, reason, conversationId, ...(reason === 'over_cap' ? { used: outcome.used, cap: outcome.cap } : {}) } };
}

// Resolve and validate a media reference: the message id must belong to this
// conversation as inbound media, so a tool can only reach media actually sent
// here — not an arbitrary platform id.
async function locateMedia(conversationId: string, messageId: string, tenantId?: string): Promise<{ conversation: ConversationSummary; target: StoredMessage } | { error: string }> {
  const conversation = await getConversation(conversationId, tenantId);
  if (!conversation) return { error: `No conversation found with id "${conversationId}".` };
  if (conversation.platform !== 'line') return { error: 'Only LINE media can be fetched right now.' };
  const messages = await getMessages({ conversationId, tenantId, limit: 1000 });
  const target = messages.find((message) => message.externalMessageId === messageId && message.direction === 'inbound' && MEDIA_TYPES.has(message.messageType));
  if (!target) return { error: `No fetchable media with id "${messageId}" in this conversation. Use the mediaId shown on a media message.` };
  return { conversation, target };
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function findTool(name: string) {
  return connectorTools.find((tool) => tool.name === name);
}

export function toolListPayload() {
  return connectorTools
    .filter((tool) => tool.enabled?.() !== false)
    .map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations ?? { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }));
}

// ---- rendering ----

function renderConversationBlock(conversation: ConversationSummary, messages: StoredMessage[]) {
  const header = [
    `## ${conversationLabel(conversation)}`,
    `conversation_id: ${conversation.conversationId}`,
    `last activity: ${formatTimestamp(conversation.lastMessageAt)}${conversation.messageCount ? ` · ${conversation.messageCount} messages captured` : ''}`,
  ];
  const participants = (conversation.participants ?? []).map((person) => person.name ?? shortId(person.id)).filter(Boolean);
  if (participants.length) header.push(`participants: ${participants.slice(0, 12).join(', ')}`);
  const body = messages.length ? messages.map(renderMessage) : ['(no messages captured in this window)'];
  return [...header, '', ...body].join('\n');
}

function renderMessage(message: StoredMessage) {
  // Continuation lines are indented so a multi-line client message stays visibly
  // part of one turn rather than reading as several.
  const text = message.text.split('\n').join('\n    ');
  return `[${formatTimestamp(message.at)}] ${speaker(message)}: ${text}`;
}

function speaker(message: StoredMessage) {
  if (message.direction === 'outbound') return `→ ${message.senderName || 'bot'}`;
  return message.senderName || shortId(message.senderId) || 'client';
}

function conversationLabel(conversation: ConversationSummary) {
  const kind = conversation.conversationType === 'direct' ? '1:1' : conversation.conversationType;
  const name = conversation.title || conversation.externalConversationId;
  return `${name} (${conversation.platform} ${kind})`;
}

function warningLine() {
  if (storeBackend() === 'postgres') return '';
  return '> Storage is in-memory, so this only shows what this instance captured since its last cold start. Set CONNECTOR_DATABASE_URL for durable history.';
}

function emptyResult(since: number | undefined, platform?: ConnectorPlatform): ToolOutput {
  const scope = platform ? `on ${platform}` : 'on LINE or WhatsApp';
  const window = since ? ` since ${formatTimestamp(since)}` : '';
  const hint = storeBackend() === 'postgres'
    ? 'If you expected chat here, call connector_status to check the channels are wired up.'
    : 'Storage is in-memory, so only messages captured by this instance since its last cold start are visible. Set CONNECTOR_DATABASE_URL for durable history, then call connector_status.';
  return {
    text: `No client conversations captured ${scope}${window}.\n\n${hint}`,
    structured: { conversations: [], storage: storeBackend() },
  };
}

function serializeConversation(conversation: ConversationSummary) {
  return {
    conversationId: conversation.conversationId,
    platform: conversation.platform,
    conversationType: conversation.conversationType,
    title: conversation.title ?? null,
    channelId: conversation.channelId,
    tenantId: conversation.tenantId,
    messageCount: conversation.messageCount ?? null,
    lastMessageAt: new Date(conversation.lastMessageAt).toISOString(),
    lastMessagePreview: conversation.lastMessagePreview ?? null,
    participants: conversation.participants ?? [],
  };
}

function serializeMessage(message: StoredMessage) {
  return {
    conversationId: message.conversationId,
    at: new Date(message.at).toISOString(),
    direction: message.direction,
    sender: message.senderName ?? message.senderId ?? null,
    messageType: message.messageType,
    text: message.text,
    // For inbound media, expose the platform message id so Claude can fetch the
    // actual image with get_image. Outbound replies carry a synthetic id that is
    // not fetchable, so they are left without one.
    mediaId: message.direction === 'inbound' && MEDIA_TYPES.has(message.messageType) ? message.externalMessageId ?? null : undefined,
  };
}

// ---- project-memory helpers ----

const DEFAULT_NOTE_TENANT = process.env.CONNECTOR_TENANT_ID?.trim() || process.env.DEFAULT_TENANT_ID?.trim() || 'demo';

function sinceProperty2(description: string) {
  return { type: 'string', description };
}

function parseWhen(raw?: string): number | undefined {
  return parseSince(raw);
}

function serializeNote(note: Note) {
  return {
    id: note.id,
    title: note.title,
    project: note.project ?? null,
    milestone: note.milestone ?? null,
    participants: note.participants,
    tags: note.tags,
    source: note.source,
    conversationId: note.conversationId ?? null,
    occurredAt: note.occurredAt ? new Date(note.occurredAt).toISOString() : null,
    createdAt: new Date(note.createdAt).toISOString(),
    updatedAt: new Date(note.updatedAt).toISOString(),
    body: note.body,
  };
}

function notesBackendLine(): string {
  return isNoteStoreDurable() ? '' : '> Notes are in-memory (no CONNECTOR_DATABASE_URL) — they are lost on cold start. Set CONNECTOR_DATABASE_URL for durable project memory.';
}

function notesEmptyText(): string {
  return `No notes in project memory yet${isNoteStoreDurable() ? '' : ' (in-memory store — set CONNECTOR_DATABASE_URL to persist)'}. Save one with save_note.`;
}

// ---- argument helpers ----

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const out = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
    return out.length ? out : undefined;
  }
  const single = readString(value);
  return single ? [single] : undefined;
}

function readInt(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function readPlatform(value: unknown): ConnectorPlatform | undefined {
  const parsed = readString(value)?.toLowerCase();
  return parsed === 'line' || parsed === 'whatsapp' ? parsed : undefined;
}

/** Accepts "24h" / "7d" / "2w" / "30m", an ISO date, or "all". */
export function parseSince(value: string | undefined, fallback?: string): number | undefined {
  const raw = (value ?? fallback)?.trim();
  if (!raw || raw.toLowerCase() === 'all') return undefined;
  const relative = raw.match(/^(\d+)\s*(m|h|d|w)$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const ms = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 604_800_000;
    return Date.now() - amount * ms;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatTimestamp(at: number) {
  const date = new Date(at);
  const timeZone = process.env.CONNECTOR_TIMEZONE?.trim();
  if (!timeZone) return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  try {
    const formatted = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
    return `${formatted} ${timeZone}`;
  } catch {
    return date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }
}

function collapse(text: string) {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > 220 ? `${single.slice(0, 217)}...` : single;
}

function shortId(id?: string) {
  if (!id) return undefined;
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}
