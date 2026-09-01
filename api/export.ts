import type { VercelRequest, VercelResponse } from '@vercel/node';
import { authorizeConnector } from '../src/connector/auth.js';
import { listNotes, type Note } from '../src/core/noteStore.js';
import { getMessages, listConversations, type ConversationSummary, type StoredMessage } from '../src/core/conversationStore.js';

// Export project memory and captured conversations as portable files.
//
//   GET /api/export?format=md|json&include=notes|conversations|all
//   auth: Authorization: Bearer <CONNECTOR_TOKEN>   or   ?key=<CONNECTOR_TOKEN>
//   query: project=, since=, limit=, messages=
//
// The point of this endpoint is that the memory is NOT locked to this
// deployment. Everything captured lives in one Neon database; this turns it into
// markdown (or JSON) you can keep, diff, grep, or move somewhere else. Reuses
// the connector's own token, because it exposes exactly the same data the
// connector does.

export const config = { maxDuration: 60 };

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;
const DEFAULT_MESSAGES_PER_CONVERSATION = 500;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = authorizeConnector({ authorization: firstQuery(req.headers.authorization), key: firstQuery(req.query.key) });
  if (!auth.ok) return res.status(auth.status).json({ error: auth.message });

  const tenantId = process.env.CONNECTOR_TENANT_ID?.trim() || undefined;
  const noteTenantId = process.env.CONNECTOR_TENANT_ID?.trim() || process.env.DEFAULT_TENANT_ID?.trim() || 'demo';
  const include = (firstQuery(req.query.include) ?? 'notes').toLowerCase();
  const wantNotes = include === 'notes' || include === 'all';
  const wantConversations = include === 'conversations' || include === 'all';
  if (!wantNotes && !wantConversations) {
    return res.status(400).json({ error: 'include must be one of: notes, conversations, all' });
  }
  const format = (firstQuery(req.query.format) ?? 'md').toLowerCase();
  if (format !== 'md' && format !== 'json') return res.status(400).json({ error: 'format must be md or json' });

  const project = firstQuery(req.query.project);
  const since = parseSince(firstQuery(req.query.since));
  const limit = clamp(Number(firstQuery(req.query.limit)) || DEFAULT_LIMIT, 1, MAX_LIMIT);
  const messagesPer = clamp(Number(firstQuery(req.query.messages)) || DEFAULT_MESSAGES_PER_CONVERSATION, 1, 5000);

  try {
    const notes = wantNotes ? await listNotes({ tenantId: noteTenantId, project, since, limit }) : [];
    const conversations: Array<{ conversation: ConversationSummary; messages: StoredMessage[] }> = [];
    if (wantConversations) {
      const summaries = await listConversations({ tenantId, since, limit: Math.min(limit, 100) });
      for (const conversation of summaries) {
        const messages = await getMessages({ conversationId: conversation.conversationId, tenantId, since, limit: messagesPer });
        conversations.push({ conversation, messages });
      }
    }

    if (format === 'json') {
      return res.status(200).json({
        exportedAt: new Date().toISOString(),
        filters: { project: project ?? null, since: since ?? null, limit, include },
        counts: { notes: notes.length, conversations: conversations.length, messages: conversations.reduce((sum, item) => sum + item.messages.length, 0) },
        notes,
        conversations,
      });
    }

    const markdown = renderMarkdown({ notes, conversations, project, since, limit });
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tecxbot-export-${new Date().toISOString().slice(0, 10)}.md"`);
    return res.status(200).send(markdown);
  } catch (error) {
    console.error('[export] Failed:', error);
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

function renderMarkdown(input: {
  notes: Note[];
  conversations: Array<{ conversation: ConversationSummary; messages: StoredMessage[] }>;
  project?: string;
  since?: number;
  limit: number;
}): string {
  const out: string[] = ['# Tecxbot export', '', `Exported: ${new Date().toISOString()}`];
  if (input.project) out.push(`Project: ${input.project}`);
  if (input.since !== undefined) out.push(`Since: ${new Date(input.since).toISOString()}`);
  out.push('');

  if (input.notes.length) {
    out.push(`## Project memory (${input.notes.length} notes)`, '');
    for (const note of input.notes) {
      out.push(`### ${note.title}`, '');
      const meta = [
        `- id: ${note.id}`,
        note.project ? `- project: ${note.project}` : '',
        note.milestone ? `- milestone: ${note.milestone}` : '',
        note.participants.length ? `- participants: ${note.participants.join(', ')}` : '',
        note.tags.length ? `- tags: ${note.tags.join(', ')}` : '',
        `- occurred: ${new Date(note.occurredAt ?? note.createdAt).toISOString()}`,
        `- source: ${note.source}`,
      ].filter(Boolean);
      out.push(...meta, '', note.body, '');
    }
  }

  for (const { conversation, messages } of input.conversations) {
    out.push(`## ${conversation.title ?? conversation.conversationId} (${messages.length} messages)`, '');
    out.push(`- id: ${conversation.conversationId}`, `- platform: ${conversation.platform}`, '');
    for (const message of messages) {
      const who = message.senderName ?? (message.direction === 'outbound' ? 'us' : 'unknown');
      out.push(`**${who}** · ${new Date(message.at).toISOString()}`, '', message.text, '');
    }
  }
  if (!input.notes.length && !input.conversations.length) out.push('_Nothing matched the filters._');
  return out.join('\n');
}

// Relative windows ("7d") look backward here, matching the connector's `since`.
function parseSince(value: string | undefined): number | undefined {
  const raw = value?.trim();
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

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function firstQuery(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
