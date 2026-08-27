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
import { getTenantChannelConfig, listConnectorChannels } from '../core/tenantStore.js';
import { downloadLineMessageContent } from '../platforms/line/client.js';

// A tool normally returns text; `content` lets it return richer MCP blocks
// (e.g. an image), which the server uses in place of the wrapped text.
export type ToolContentBlock = { type: string; [key: string]: unknown };
export type ToolOutput = { text: string; structured: Record<string, unknown>; content?: ToolContentBlock[] };

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolOutput>;
};

// Inlining an image as base64 inflates the JSON-RPC response ~1.33x, and the
// model has to ingest all of it — so cap what get_image will return.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
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
      const lines = [
        '# Tecxbot connector status',
        '',
        `storage: ${stats.backend}${stats.durable ? ' (durable)' : ' (in-memory — history is lost on every cold start)'}`,
        `capture: ${isCaptureEnabled() ? 'on' : 'off (CONNECTOR_CAPTURE=false)'}`,
        `conversations captured: ${stats.conversations}`,
        `messages captured: ${stats.messages}`,
        `last captured message: ${stats.lastMessageAt ? formatTimestamp(stats.lastMessageAt) : 'none yet'}`,
        '',
        'Configured channels:',
        ...(channels.length ? channels.map((channel) => `- ${channel.platform}: ${channel.id} (${channel.label})`) : ['- none — no messaging credentials are set']),
      ];
      if (stats.error) lines.push('', `storage error: ${stats.error}`);
      if (!stats.durable) lines.push('', 'To keep history across requests, set CONNECTOR_DATABASE_URL to a Postgres connection string.');
      return { text: lines.join('\n'), structured: { ...stats, capture: isCaptureEnabled(), channels } };
    },
  },

  {
    name: 'get_image',
    title: 'View an image a client sent',
    description:
      'Fetch and view an image message a client sent on LINE, so you can actually see it. Pass the conversation_id and the message\'s `mediaId` (shown on image messages in get_conversation / latest_context). The image is fetched live from LINE on demand — nothing is stored — so it works for recent images while LINE still retains the media.',
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

      const conversation = await getConversation(conversationId, tenantId);
      if (!conversation) return imageError(`No conversation found with id "${conversationId}".`);
      if (conversation.platform !== 'line') return imageError('Only LINE images can be fetched right now.');

      // Confirm the id really belongs to this conversation and is inbound media —
      // so this tool can only reach images a client actually sent here, not an
      // arbitrary platform message id.
      const messages = await getMessages({ conversationId, tenantId, limit: 1000 });
      const target = messages.find((message) => message.externalMessageId === messageId && message.direction === 'inbound' && MEDIA_TYPES.has(message.messageType));
      if (!target) return imageError(`No fetchable media with id "${messageId}" in this conversation. Use the mediaId shown on an inbound image message.`);

      const token = lineChannelToken(conversation.channelId);
      if (!token) return imageError(`LINE channel "${conversation.channelId}" has no access token configured, so its media can't be fetched.`);

      let media: { content: ArrayBuffer; contentType: string };
      try {
        media = await downloadLineMessageContent(messageId, token);
      } catch (error) {
        // LINE only keeps message content for a limited window; an old image is
        // simply gone rather than an error worth surfacing as a crash.
        return imageError(`Couldn't fetch that image from LINE — it may have expired. (${formatError(error)})`);
      }

      const bytes = media.content.byteLength;
      if (bytes > MAX_IMAGE_BYTES) return imageError(`That image is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024} MB inline limit.`);
      if (!media.contentType.startsWith('image/')) return imageError(`That message is not an image (content type: ${media.contentType}).`);

      const base64 = Buffer.from(media.content).toString('base64');
      const caption = `Image from ${conversationLabel(conversation)}, sent by ${target.senderName || shortId(target.senderId) || 'client'} at ${formatTimestamp(target.at)}.`;
      return {
        text: caption,
        structured: { conversationId, messageId, mimeType: media.contentType, bytes, sentAt: new Date(target.at).toISOString() },
        content: [
          { type: 'text', text: caption },
          { type: 'image', data: base64, mimeType: media.contentType },
        ],
      };
    },
  },
];

function imageError(message: string): ToolOutput {
  return { text: message, structured: { error: message } };
}

function lineChannelToken(channelId: string): string | undefined {
  try {
    return getTenantChannelConfig(channelId).line?.channelAccessToken || undefined;
  } catch {
    return undefined;
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function findTool(name: string) {
  return connectorTools.find((tool) => tool.name === name);
}

export function toolListPayload() {
  return connectorTools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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

// ---- argument helpers ----

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
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
