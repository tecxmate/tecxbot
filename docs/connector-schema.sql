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
  at_ms bigint not null
);

create index if not exists connector_messages_conversation_idx
  on connector_messages (conversation_id, at_ms desc);

create index if not exists connector_messages_recent_idx
  on connector_messages (at_ms desc);

-- Makes a redelivered LINE / WhatsApp webhook a no-op instead of a duplicate.
create unique index if not exists connector_messages_external_idx
  on connector_messages (conversation_id, external_message_id)
  where external_message_id is not null;

-- Optional retention. Nothing deletes on its own; run this on a schedule if you
-- only want to keep a rolling window of client chat.
--
--   delete from connector_messages
--    where at_ms < (extract(epoch from now()) * 1000)::bigint - (90 * 86400000);
