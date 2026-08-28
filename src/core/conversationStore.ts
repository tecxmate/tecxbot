// Durable log of client conversations, shared by every platform adapter and
// read back by the Claude connector (`api/mcp.ts`).
//
// The bot's existing stores are deliberately in-memory and short-lived: they
// exist to drive one reply. This one is different — a connector is a *separate*
// serverless invocation from the webhook that captured the message, so the log
// has to survive the request that wrote it. Two drivers:
//
//   postgres  when CONNECTOR_DATABASE_URL / DATABASE_URL is set (production)
//   memory    otherwise (local dev, `vercel dev`, tests)
//
// The memory driver is a real fallback, not a stub: everything works, it just
// forgets on cold start and each serverless instance sees only its own writes.

import { isSqlConfigured, sql, sqlBatch } from './sql.js';

export type ConnectorPlatform = 'line' | 'whatsapp';
export type ConversationType = 'direct' | 'group' | 'room';
export type MessageDirection = 'inbound' | 'outbound';

export type RecordMessageInput = {
  tenantId: string;
  channelId: string;
  platform: ConnectorPlatform;
  conversationType: ConversationType;
  externalConversationId: string;
  /** Group name, or the contact's display name for a 1:1 chat. */
  title?: string;
  direction: MessageDirection;
  senderId?: string;
  senderName?: string;
  text: string;
  messageType?: string;
  /** Platform message id. Used to make redelivered webhooks idempotent. */
  externalMessageId?: string;
  at?: number;
};

export type StoredMessage = {
  id: string;
  conversationId: string;
  tenantId: string;
  channelId: string;
  platform: ConnectorPlatform;
  direction: MessageDirection;
  senderId?: string;
  senderName?: string;
  messageType: string;
  externalMessageId?: string;
  text: string;
  at: number;
  /** R2 object key once the media has been archived; absent until then. */
  mediaKey?: string;
};

export type ConversationSummary = {
  conversationId: string;
  tenantId: string;
  channelId: string;
  platform: ConnectorPlatform;
  conversationType: ConversationType;
  externalConversationId: string;
  title?: string;
  lastMessageAt: number;
  lastMessagePreview?: string;
  lastDirection?: MessageDirection;
  messageCount?: number;
  participants?: Participant[];
};

export type Participant = { id: string; name?: string; messageCount: number; lastMessageAt: number };

export type ListConversationsQuery = {
  tenantId?: string;
  platform?: ConnectorPlatform;
  /** Epoch ms; only conversations active at or after this point. */
  since?: number;
  /** Substring match against the conversation title. */
  query?: string;
  limit?: number;
};

export type MessagesQuery = {
  conversationId: string;
  tenantId?: string;
  since?: number;
  limit?: number;
};

export type SearchQuery = {
  query: string;
  tenantId?: string;
  platform?: ConnectorPlatform;
  conversationId?: string;
  since?: number;
  limit?: number;
};

export type StoreStats = {
  backend: 'postgres' | 'memory';
  durable: boolean;
  conversations: number;
  messages: number;
  lastMessageAt?: number;
  error?: string;
};

export const MAX_TEXT_LENGTH = 4000;
const PREVIEW_LENGTH = 160;

export function buildConversationId(input: { platform: ConnectorPlatform; channelId: string; conversationType: ConversationType; externalConversationId: string }) {
  return `${input.platform}:${input.channelId}:${input.conversationType}:${input.externalConversationId}`;
}

export function isCaptureEnabled() {
  return (process.env.CONNECTOR_CAPTURE ?? 'true').toLowerCase() !== 'false';
}

export function storeBackend(): StoreStats['backend'] {
  return isSqlConfigured() ? 'postgres' : 'memory';
}

/**
 * Best-effort write. Capturing chat history must never break a reply, so
 * failures are logged and swallowed — the caller is a live webhook.
 */
export async function recordMessage(input: RecordMessageInput): Promise<void> {
  if (!isCaptureEnabled()) return;
  const text = input.text.trim();
  if (!text) return;
  const message = normalize(input, text);
  try {
    await driver().recordMessage(message.conversation, message.message);
  } catch (error) {
    console.error('[conversation-store] Failed to record message:', error);
  }
}

export async function listConversations(query: ListConversationsQuery = {}): Promise<ConversationSummary[]> {
  return driver().listConversations({ ...query, limit: clamp(query.limit ?? 20, 1, 200) });
}

export async function getConversation(conversationId: string, tenantId?: string): Promise<ConversationSummary | undefined> {
  return driver().getConversation(conversationId, tenantId);
}

export async function getMessages(query: MessagesQuery): Promise<StoredMessage[]> {
  return driver().getMessages({ ...query, limit: clamp(query.limit ?? 50, 1, 1000) });
}

export async function searchMessages(query: SearchQuery): Promise<StoredMessage[]> {
  return driver().searchMessages({ ...query, limit: clamp(query.limit ?? 30, 1, 200) });
}

export async function getStats(tenantId?: string): Promise<StoreStats> {
  try {
    return await driver().stats(tenantId);
  } catch (error) {
    return { backend: storeBackend(), durable: storeBackend() === 'postgres', conversations: 0, messages: 0, error: formatError(error) };
  }
}

export type PruneResult = { messagesDeleted: number; conversationsDeleted: number };

/**
 * Delete messages older than `cutoffMs`, then remove any conversation left with
 * no messages. Keeps the log bounded so it doesn't grow without limit. A
 * conversation with any message newer than the cutoff is untouched.
 */
export async function pruneOlderThan(cutoffMs: number): Promise<PruneResult> {
  return driver().prune(cutoffMs);
}

const MEDIA_MESSAGE_TYPES = ['image', 'file', 'audio'];

/**
 * Inbound media messages captured at or after `sinceMs` that have a platform id
 * but haven't been archived yet — the archive job's work queue. Bounded by
 * `sinceMs` because platform media is only fetchable for a limited window.
 */
export async function listUnarchivedMedia(input: { sinceMs: number; limit?: number }): Promise<StoredMessage[]> {
  return driver().listUnarchivedMedia({ sinceMs: input.sinceMs, limit: clamp(input.limit ?? 25, 1, 200) });
}

/** Record the R2 object key for a message once its media has been archived. */
export async function setMediaKey(messageId: string, mediaKey: string): Promise<void> {
  await driver().setMediaKey(messageId, mediaKey);
}

// Every PM reply the connector pushes is recorded as an outbound message whose
// external_message_id starts with this marker (a real LINE message id never
// does). Counting them is how the monthly push cap tracks LINE quota usage
// without a separate counter table.
export const REPLY_PUSH_PREFIX = 'pm-reply:';

/** How many PM reply pushes have been recorded at or after `sinceMs`. */
export async function countReplyPushesSince(sinceMs: number): Promise<number> {
  return driver().countReplyPushesSince(sinceMs);
}

// ---- normalization ----

type ConversationRow = Omit<ConversationSummary, 'messageCount' | 'participants'>;

function normalize(input: RecordMessageInput, text: string): { conversation: ConversationRow; message: StoredMessage } {
  const at = input.at ?? Date.now();
  const conversationId = buildConversationId(input);
  const clipped = text.slice(0, MAX_TEXT_LENGTH);
  return {
    conversation: {
      conversationId,
      tenantId: input.tenantId,
      channelId: input.channelId,
      platform: input.platform,
      conversationType: input.conversationType,
      externalConversationId: input.externalConversationId,
      title: input.title?.trim() || undefined,
      lastMessageAt: at,
      lastMessagePreview: clipped.replace(/\s+/g, ' ').slice(0, PREVIEW_LENGTH),
      lastDirection: input.direction,
    },
    message: {
      id: messageId(),
      conversationId,
      tenantId: input.tenantId,
      channelId: input.channelId,
      platform: input.platform,
      direction: input.direction,
      senderId: input.senderId,
      senderName: input.senderName?.trim() || undefined,
      messageType: input.messageType || 'text',
      externalMessageId: input.externalMessageId,
      text: clipped,
      at,
    },
  };
}

let messageCounter = 0;

function messageId() {
  messageCounter += 1;
  return `msg_${Date.now().toString(36)}_${messageCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---- driver selection ----

type Driver = {
  recordMessage(conversation: ConversationRow, message: StoredMessage): Promise<void>;
  listConversations(query: ListConversationsQuery): Promise<ConversationSummary[]>;
  getConversation(conversationId: string, tenantId?: string): Promise<ConversationSummary | undefined>;
  getMessages(query: MessagesQuery): Promise<StoredMessage[]>;
  searchMessages(query: SearchQuery): Promise<StoredMessage[]>;
  stats(tenantId?: string): Promise<StoreStats>;
  prune(cutoffMs: number): Promise<PruneResult>;
  listUnarchivedMedia(input: { sinceMs: number; limit: number }): Promise<StoredMessage[]>;
  setMediaKey(messageId: string, mediaKey: string): Promise<void>;
  countReplyPushesSince(sinceMs: number): Promise<number>;
};

function driver(): Driver {
  return isSqlConfigured() ? postgresDriver : memoryDriver;
}

// ---- memory driver ----

const memoryConversations = new Map<string, ConversationRow>();
const memoryMessages = new Map<string, StoredMessage[]>();
const MEMORY_MAX_CONVERSATIONS = 200;
const MEMORY_MAX_MESSAGES = 500;

const memoryDriver: Driver = {
  async recordMessage(conversation, message) {
    const existing = memoryConversations.get(conversation.conversationId);
    memoryConversations.set(conversation.conversationId, existing ? mergeConversation(existing, conversation) : conversation);
    const messages = memoryMessages.get(conversation.conversationId) ?? [];
    const duplicate = message.externalMessageId && messages.some((item) => item.externalMessageId === message.externalMessageId);
    if (!duplicate) {
      messages.push(message);
      memoryMessages.set(conversation.conversationId, messages.slice(-MEMORY_MAX_MESSAGES));
    }
    evictMemoryConversations();
  },

  async listConversations(query) {
    const needle = query.query?.trim().toLowerCase();
    const rows = [...memoryConversations.values()]
      .filter((row) => matchesFilters(row, query))
      .filter((row) => !needle || (row.title ?? '').toLowerCase().includes(needle) || row.externalConversationId.toLowerCase().includes(needle))
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
      .slice(0, query.limit);
    return rows.map((row) => ({ ...row, ...deriveMemoryAggregates(row.conversationId) }));
  },

  async getConversation(conversationId, tenantId) {
    const row = memoryConversations.get(conversationId);
    if (!row || (tenantId && row.tenantId !== tenantId)) return undefined;
    return { ...row, ...deriveMemoryAggregates(conversationId) };
  },

  async getMessages(query) {
    const row = memoryConversations.get(query.conversationId);
    if (!row || (query.tenantId && row.tenantId !== query.tenantId)) return [];
    const messages = memoryMessages.get(query.conversationId) ?? [];
    return messages.filter((item) => !query.since || item.at >= query.since).slice(-(query.limit ?? 50));
  },

  async searchMessages(query) {
    const needle = query.query.trim().toLowerCase();
    if (!needle) return [];
    const matches: StoredMessage[] = [];
    for (const [conversationId, messages] of memoryMessages.entries()) {
      const conversation = memoryConversations.get(conversationId);
      if (!conversation || !matchesFilters(conversation, query)) continue;
      if (query.conversationId && conversationId !== query.conversationId) continue;
      for (const message of messages) {
        if (query.since && message.at < query.since) continue;
        if (message.text.toLowerCase().includes(needle)) matches.push(message);
      }
    }
    return matches.sort((a, b) => b.at - a.at).slice(0, query.limit);
  },

  async stats(tenantId) {
    const conversations = [...memoryConversations.values()].filter((row) => !tenantId || row.tenantId === tenantId);
    const messages = conversations.reduce((total, row) => total + (memoryMessages.get(row.conversationId)?.length ?? 0), 0);
    const lastMessageAt = conversations.reduce((latest, row) => Math.max(latest, row.lastMessageAt), 0);
    return { backend: 'memory', durable: false, conversations: conversations.length, messages, lastMessageAt: lastMessageAt || undefined };
  },

  async prune(cutoffMs) {
    let messagesDeleted = 0;
    let conversationsDeleted = 0;
    for (const [conversationId, messages] of memoryMessages.entries()) {
      const kept = messages.filter((message) => message.at >= cutoffMs);
      messagesDeleted += messages.length - kept.length;
      if (kept.length) {
        memoryMessages.set(conversationId, kept);
      } else {
        memoryMessages.delete(conversationId);
        memoryConversations.delete(conversationId);
        conversationsDeleted += 1;
      }
    }
    return { messagesDeleted, conversationsDeleted };
  },

  async listUnarchivedMedia({ sinceMs, limit }) {
    const out: StoredMessage[] = [];
    for (const messages of memoryMessages.values()) {
      for (const message of messages) {
        if (message.direction === 'inbound' && MEDIA_MESSAGE_TYPES.includes(message.messageType) && message.externalMessageId && !message.mediaKey && message.at >= sinceMs) {
          out.push(message);
        }
      }
    }
    return out.sort((a, b) => b.at - a.at).slice(0, limit);
  },

  async countReplyPushesSince(sinceMs) {
    let count = 0;
    for (const messages of memoryMessages.values()) {
      for (const message of messages) {
        if (message.direction === 'outbound' && message.at >= sinceMs && (message.externalMessageId ?? '').startsWith(REPLY_PUSH_PREFIX)) count += 1;
      }
    }
    return count;
  },

  async setMediaKey(messageId, mediaKey) {
    for (const messages of memoryMessages.values()) {
      const target = messages.find((message) => message.id === messageId);
      if (target) { target.mediaKey = mediaKey; return; }
    }
  },
};

function mergeConversation(existing: ConversationRow, incoming: ConversationRow): ConversationRow {
  const newer = incoming.lastMessageAt >= existing.lastMessageAt;
  return {
    ...existing,
    title: incoming.title ?? existing.title,
    lastMessageAt: Math.max(existing.lastMessageAt, incoming.lastMessageAt),
    lastMessagePreview: newer ? incoming.lastMessagePreview : existing.lastMessagePreview,
    lastDirection: newer ? incoming.lastDirection : existing.lastDirection,
  };
}

function deriveMemoryAggregates(conversationId: string) {
  const messages = memoryMessages.get(conversationId) ?? [];
  const byParticipant = new Map<string, Participant>();
  for (const message of messages) {
    if (message.direction !== 'inbound' || !message.senderId) continue;
    const current = byParticipant.get(message.senderId);
    byParticipant.set(message.senderId, {
      id: message.senderId,
      name: message.senderName ?? current?.name,
      messageCount: (current?.messageCount ?? 0) + 1,
      lastMessageAt: Math.max(current?.lastMessageAt ?? 0, message.at),
    });
  }
  return {
    messageCount: messages.length,
    participants: [...byParticipant.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt),
  };
}

function matchesFilters(row: ConversationRow, query: { tenantId?: string; platform?: ConnectorPlatform; since?: number }) {
  if (query.tenantId && row.tenantId !== query.tenantId) return false;
  if (query.platform && row.platform !== query.platform) return false;
  if (query.since && row.lastMessageAt < query.since) return false;
  return true;
}

function evictMemoryConversations() {
  if (memoryConversations.size <= MEMORY_MAX_CONVERSATIONS) return;
  const stale = [...memoryConversations.values()].sort((a, b) => a.lastMessageAt - b.lastMessageAt).slice(0, memoryConversations.size - MEMORY_MAX_CONVERSATIONS);
  for (const row of stale) {
    memoryConversations.delete(row.conversationId);
    memoryMessages.delete(row.conversationId);
  }
}

// ---- postgres driver ----

let schemaPromise: Promise<void> | undefined;

function ensureSchema() {
  schemaPromise ??= sqlBatch([
    {
      query: `create table if not exists connector_conversations (
        conversation_id text primary key,
        tenant_id text not null,
        channel_id text not null,
        platform text not null,
        conversation_type text not null,
        external_conversation_id text not null,
        title text,
        last_message_at bigint not null default 0,
        last_message_preview text,
        last_direction text,
        created_at bigint not null,
        updated_at bigint not null
      )`,
    },
    { query: `create index if not exists connector_conversations_recent_idx on connector_conversations (last_message_at desc)` },
    { query: `create index if not exists connector_conversations_platform_idx on connector_conversations (platform, last_message_at desc)` },
    {
      query: `create table if not exists connector_messages (
        id text primary key,
        conversation_id text not null references connector_conversations(conversation_id) on delete cascade,
        tenant_id text not null,
        channel_id text not null,
        platform text not null,
        direction text not null,
        sender_id text,
        sender_name text,
        message_type text not null default 'text',
        external_message_id text,
        text text not null,
        at_ms bigint not null
      )`,
    },
    { query: `create index if not exists connector_messages_conversation_idx on connector_messages (conversation_id, at_ms desc)` },
    { query: `create index if not exists connector_messages_recent_idx on connector_messages (at_ms desc)` },
    { query: `create unique index if not exists connector_messages_external_idx on connector_messages (conversation_id, external_message_id) where external_message_id is not null` },
    // Added after the initial release; `if not exists` makes it a no-op on
    // databases that already have the column.
    { query: `alter table connector_messages add column if not exists media_key text` },
    { query: `create index if not exists connector_messages_unarchived_idx on connector_messages (at_ms desc) where media_key is null and external_message_id is not null` },
  ]).catch((error) => {
    schemaPromise = undefined; // let the next request retry a transient failure
    throw error;
  });
  return schemaPromise;
}

const postgresDriver: Driver = {
  async recordMessage(conversation, message) {
    await ensureSchema();
    // One round trip, one transaction: upsert the conversation, then append the
    // message. `on conflict do nothing` makes a redelivered webhook a no-op.
    await sqlBatch([
      {
        query: `insert into connector_conversations
            (conversation_id, tenant_id, channel_id, platform, conversation_type, external_conversation_id, title, last_message_at, last_message_preview, last_direction, created_at, updated_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $8, $8)
          on conflict (conversation_id) do update set
            title = coalesce(nullif(excluded.title, ''), connector_conversations.title),
            last_message_at = greatest(connector_conversations.last_message_at, excluded.last_message_at),
            last_message_preview = case when excluded.last_message_at >= connector_conversations.last_message_at then excluded.last_message_preview else connector_conversations.last_message_preview end,
            last_direction = case when excluded.last_message_at >= connector_conversations.last_message_at then excluded.last_direction else connector_conversations.last_direction end,
            updated_at = greatest(connector_conversations.updated_at, excluded.updated_at)`,
        params: [
          conversation.conversationId,
          conversation.tenantId,
          conversation.channelId,
          conversation.platform,
          conversation.conversationType,
          conversation.externalConversationId,
          conversation.title ?? null,
          conversation.lastMessageAt,
          conversation.lastMessagePreview ?? null,
          conversation.lastDirection ?? null,
        ],
      },
      {
        query: `insert into connector_messages
            (id, conversation_id, tenant_id, channel_id, platform, direction, sender_id, sender_name, message_type, external_message_id, text, at_ms)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          on conflict do nothing`,
        params: [
          message.id,
          message.conversationId,
          message.tenantId,
          message.channelId,
          message.platform,
          message.direction,
          message.senderId ?? null,
          message.senderName ?? null,
          message.messageType,
          message.externalMessageId ?? null,
          message.text,
          message.at,
        ],
      },
    ]);
  },

  async listConversations(query) {
    await ensureSchema();
    const rows = await sql<Record<string, unknown>>(
      `select * from connector_conversations
        where ($1::text is null or tenant_id = $1)
          and ($2::text is null or platform = $2)
          and ($3::bigint is null or last_message_at >= $3)
          and ($4::text is null or position(lower($4) in lower(coalesce(title, '') || ' ' || external_conversation_id)) > 0)
        order by last_message_at desc
        limit $5`,
      [query.tenantId ?? null, query.platform ?? null, query.since ?? null, query.query?.trim() || null, query.limit ?? 20],
    );
    const conversations = rows.map(toConversation);
    return attachAggregates(conversations);
  },

  async getConversation(conversationId, tenantId) {
    await ensureSchema();
    const rows = await sql<Record<string, unknown>>(
      `select * from connector_conversations where conversation_id = $1 and ($2::text is null or tenant_id = $2)`,
      [conversationId, tenantId ?? null],
    );
    if (!rows.length) return undefined;
    return (await attachAggregates([toConversation(rows[0])]))[0];
  },

  async getMessages(query) {
    await ensureSchema();
    // Newest-first in SQL so `limit` keeps the *latest* slice, then flipped back
    // to chronological order for reading.
    const rows = await sql<Record<string, unknown>>(
      `select * from connector_messages
        where conversation_id = $1
          and ($2::text is null or tenant_id = $2)
          and ($3::bigint is null or at_ms >= $3)
        order by at_ms desc, id desc
        limit $4`,
      [query.conversationId, query.tenantId ?? null, query.since ?? null, query.limit ?? 50],
    );
    return rows.map(toMessage).reverse();
  },

  async searchMessages(query) {
    await ensureSchema();
    const needle = query.query.trim();
    if (!needle) return [];
    const rows = await sql<Record<string, unknown>>(
      `select * from connector_messages
        where position(lower($1) in lower(text)) > 0
          and ($2::text is null or tenant_id = $2)
          and ($3::text is null or platform = $3)
          and ($4::text is null or conversation_id = $4)
          and ($5::bigint is null or at_ms >= $5)
        order by at_ms desc
        limit $6`,
      [needle, query.tenantId ?? null, query.platform ?? null, query.conversationId ?? null, query.since ?? null, query.limit ?? 30],
    );
    return rows.map(toMessage);
  },

  async stats(tenantId) {
    await ensureSchema();
    const rows = await sql<Record<string, unknown>>(
      `select
          (select count(*) from connector_conversations where ($1::text is null or tenant_id = $1)) as conversations,
          (select count(*) from connector_messages where ($1::text is null or tenant_id = $1)) as messages,
          (select max(at_ms) from connector_messages where ($1::text is null or tenant_id = $1)) as last_message_at`,
      [tenantId ?? null],
    );
    const row = rows[0] ?? {};
    return {
      backend: 'postgres',
      durable: true,
      conversations: toNumber(row.conversations),
      messages: toNumber(row.messages),
      lastMessageAt: toNumber(row.last_message_at) || undefined,
    };
  },

  async prune(cutoffMs) {
    await ensureSchema();
    // `returning` counts rows without a second scan. The conversation sweep
    // removes only rows with no messages left, so a chat with any recent
    // activity is preserved even if some of its messages aged out.
    const deletedMessages = await sql<Record<string, unknown>>(
      `delete from connector_messages where at_ms < $1 returning id`,
      [cutoffMs],
    );
    const deletedConversations = await sql<Record<string, unknown>>(
      `delete from connector_conversations c
        where not exists (select 1 from connector_messages m where m.conversation_id = c.conversation_id)
        returning conversation_id`,
      [],
    );
    return { messagesDeleted: deletedMessages.length, conversationsDeleted: deletedConversations.length };
  },

  async listUnarchivedMedia({ sinceMs, limit }) {
    await ensureSchema();
    const rows = await sql<Record<string, unknown>>(
      `select * from connector_messages
        where direction = 'inbound'
          and message_type = any($1::text[])
          and external_message_id is not null
          and media_key is null
          and at_ms >= $2
        order by at_ms desc
        limit $3`,
      [MEDIA_MESSAGE_TYPES, sinceMs, limit],
    );
    return rows.map(toMessage);
  },

  async setMediaKey(messageId, mediaKey) {
    await ensureSchema();
    await sql(`update connector_messages set media_key = $2 where id = $1`, [messageId, mediaKey]);
  },

  async countReplyPushesSince(sinceMs) {
    await ensureSchema();
    const rows = await sql<Record<string, unknown>>(
      `select count(*) as n from connector_messages
        where direction = 'outbound' and at_ms >= $1 and external_message_id like $2`,
      [sinceMs, `${REPLY_PUSH_PREFIX}%`],
    );
    return toNumber(rows[0]?.n);
  },
};

// Message counts and participant lists are derived from the message table
// rather than denormalized onto the conversation row, so a redelivered webhook
// can never drift the totals.
async function attachAggregates(conversations: ConversationSummary[]): Promise<ConversationSummary[]> {
  if (!conversations.length) return conversations;
  const ids = conversations.map((item) => item.conversationId);
  const [counts, participants] = await Promise.all([
    sql<Record<string, unknown>>(`select conversation_id, count(*) as message_count from connector_messages where conversation_id = any($1::text[]) group by conversation_id`, [ids]),
    sql<Record<string, unknown>>(
      `select conversation_id, sender_id, max(sender_name) as sender_name, count(*) as message_count, max(at_ms) as last_message_at
        from connector_messages
        where conversation_id = any($1::text[]) and direction = 'inbound' and sender_id is not null
        group by conversation_id, sender_id`,
      [ids],
    ),
  ]);
  const countById = new Map(counts.map((row) => [String(row.conversation_id), toNumber(row.message_count)]));
  const participantsById = new Map<string, Participant[]>();
  for (const row of participants) {
    const conversationId = String(row.conversation_id);
    const list = participantsById.get(conversationId) ?? [];
    list.push({
      id: String(row.sender_id),
      name: row.sender_name ? String(row.sender_name) : undefined,
      messageCount: toNumber(row.message_count),
      lastMessageAt: toNumber(row.last_message_at),
    });
    participantsById.set(conversationId, list);
  }
  return conversations.map((conversation) => ({
    ...conversation,
    messageCount: countById.get(conversation.conversationId) ?? 0,
    participants: (participantsById.get(conversation.conversationId) ?? []).sort((a, b) => b.lastMessageAt - a.lastMessageAt),
  }));
}

function toConversation(row: Record<string, unknown>): ConversationSummary {
  return {
    conversationId: String(row.conversation_id),
    tenantId: String(row.tenant_id),
    channelId: String(row.channel_id),
    platform: String(row.platform) as ConnectorPlatform,
    conversationType: String(row.conversation_type) as ConversationType,
    externalConversationId: String(row.external_conversation_id),
    title: row.title ? String(row.title) : undefined,
    lastMessageAt: toNumber(row.last_message_at),
    lastMessagePreview: row.last_message_preview ? String(row.last_message_preview) : undefined,
    lastDirection: row.last_direction ? (String(row.last_direction) as MessageDirection) : undefined,
  };
}

function toMessage(row: Record<string, unknown>): StoredMessage {
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    tenantId: String(row.tenant_id),
    channelId: String(row.channel_id),
    platform: String(row.platform) as ConnectorPlatform,
    direction: String(row.direction) as MessageDirection,
    senderId: row.sender_id ? String(row.sender_id) : undefined,
    senderName: row.sender_name ? String(row.sender_name) : undefined,
    messageType: String(row.message_type ?? 'text'),
    externalMessageId: row.external_message_id ? String(row.external_message_id) : undefined,
    text: String(row.text ?? ''),
    at: toNumber(row.at_ms),
    mediaKey: row.media_key ? String(row.media_key) : undefined,
  };
}

// bigint columns come back as either a JSON number or a string depending on the
// proxy's type handling — normalize both.
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
