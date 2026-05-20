create extension if not exists pgcrypto;

create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  default_language text not null default 'zh-TW',
  domain_context text not null default '',
  bot_mention_names text[] not null default array['bot'],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tenant_plans (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  plan_id text not null default 'free',
  plan_name text not null default 'Free trial',
  character_limit integer not null default 5000,
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_started_at timestamptz not null default now(),
  current_period_ends_at timestamptz,
  used_characters integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists tenant_channels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  platform text not null check (platform in ('line', 'telegram', 'whatsapp', 'zalo', 'web')),
  label text not null,
  status text not null default 'active' check (status in ('active', 'paused', 'disabled')),
  bot_system_kind text not null default 'group_translator' check (bot_system_kind in ('group_translator', 'mcp_agent')),
  bot_system_config jsonb not null default '{"kind":"group_translator"}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_channels_tenant_id_idx on tenant_channels(tenant_id);

create table if not exists line_channel_credentials (
  tenant_channel_id uuid primary key references tenant_channels(id) on delete cascade,
  channel_id text,
  channel_secret_encrypted text not null,
  channel_access_token_encrypted text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists line_group_settings (
  tenant_channel_id uuid not null references tenant_channels(id) on delete cascade,
  line_group_id text not null,
  target_languages text[] not null default '{}',
  disabled_user_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_channel_id, line_group_id)
);

create table if not exists conversation_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  tenant_channel_id uuid not null references tenant_channels(id) on delete cascade,
  platform text not null,
  source_type text not null,
  source_id text not null,
  user_id text,
  role text not null check (role in ('user', 'assistant', 'system')),
  text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists conversation_messages_lookup_idx
  on conversation_messages(tenant_channel_id, source_type, source_id, created_at desc);

create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  tenant_channel_id uuid references tenant_channels(id) on delete set null,
  event_type text not null,
  quantity integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists usage_events_tenant_created_idx
  on usage_events(tenant_id, created_at desc);

create table if not exists user_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  tenant_channel_id uuid not null references tenant_channels(id) on delete cascade,
  platform text not null check (platform in ('line', 'telegram', 'whatsapp', 'zalo', 'web')),
  platform_user_id text not null,
  plan_id text not null default 'free',
  language text not null default 'tw' check (language in ('tw', 'en')),
  tone text not null default 'balanced' check (tone in ('concise', 'balanced', 'technical')),
  risk text not null default 'balanced' check (risk in ('conservative', 'balanced', 'aggressive')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_channel_id, platform, platform_user_id)
);

create index if not exists user_profiles_tenant_idx
  on user_profiles(tenant_id, tenant_channel_id);

create table if not exists user_watchlist_items (
  id uuid primary key default gen_random_uuid(),
  user_profile_id uuid not null references user_profiles(id) on delete cascade,
  ticker text not null,
  company_name text,
  pillar text,
  node text,
  reason text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_profile_id, ticker)
);

create index if not exists user_watchlist_items_profile_status_idx
  on user_watchlist_items(user_profile_id, status, updated_at desc);

create table if not exists user_watchlist_brief_reminders (
  id uuid primary key default gen_random_uuid(),
  user_profile_id uuid not null references user_profiles(id) on delete cascade,
  time_of_day time not null,
  timezone text not null default 'Asia/Taipei',
  template text not null default 'premarket' check (template in ('premarket', 'midday', 'postclose', 'risk', 'news', 'flow')),
  enabled boolean not null default true,
  last_sent_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists user_watchlist_brief_reminders_due_idx
  on user_watchlist_brief_reminders(enabled, timezone, time_of_day);
