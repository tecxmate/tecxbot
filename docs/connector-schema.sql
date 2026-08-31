-- Claude connector storage.
--
-- `src/core/conversationStore.ts` creates these tables automatically on the
-- first write, so you do not have to run this file. It is here so you can see
-- the shape, review indexes, or provision the schema ahead of time.

create table if not exists connector_conversations (
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
);

create index if not exists connector_conversations_recent_idx
  on connector_conversations (last_message_at desc);

create index if not exists connector_conversations_platform_idx
  on connector_conversations (platform, last_message_at desc);

create table if not exists connector_messages (
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
  at_ms bigint not null,
  -- R2 object key once media is archived (null until the archive-media job runs).
  media_key text
);

create index if not exists connector_messages_conversation_idx
  on connector_messages (conversation_id, at_ms desc);

create index if not exists connector_messages_recent_idx
  on connector_messages (at_ms desc);

-- Makes a redelivered LINE / WhatsApp webhook a no-op instead of a duplicate.
create unique index if not exists connector_messages_external_idx
  on connector_messages (conversation_id, external_message_id)
  where external_message_id is not null;

-- Project memory: durable, taggable notes and transcripts, independent of any
-- chat platform. Created automatically by src/core/noteStore.ts on the first
-- save_note. Participants and tags are stored as JSON text (portable across the
-- SQL-over-HTTP client); filtering by tag/participant happens in the app.
create table if not exists connector_notes (
  id text primary key,
  tenant_id text not null,
  title text not null,
  body text not null,
  source text not null default 'note',
  project text,
  milestone text,
  participants_json text not null default '[]',
  tags_json text not null default '[]',
  conversation_id text,
  occurred_at bigint,
  created_at bigint not null,
  updated_at bigint not null
);

create index if not exists connector_notes_recent_idx
  on connector_notes (tenant_id, coalesce(occurred_at, created_at) desc);

create index if not exists connector_notes_project_idx
  on connector_notes (tenant_id, project);

-- Retention. The `connector-prune` cron job does this for you on a schedule
-- (GET /api/cron?job=connector-prune), deleting messages older than
-- CONNECTOR_RETENTION_DAYS and then any conversation left empty. To run it by
-- hand instead:
--
--   delete from connector_messages
--    where at_ms < (extract(epoch from now()) * 1000)::bigint - (90 * 86400000);
--   delete from connector_conversations c
--    where not exists (select 1 from connector_messages m where m.conversation_id = c.conversation_id);
