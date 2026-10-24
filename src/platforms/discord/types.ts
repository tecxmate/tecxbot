// The slice of Discord's MESSAGE_CREATE payload this project reads.
//
// Deliberately partial: the gateway sends a large object and most of it is
// irrelevant to capture. Narrowing here means a Discord schema change can only
// break the fields actually used, and makes the forwarded payload small enough
// to validate cheaply at the ingest endpoint.

export type DiscordAuthor = {
  id: string;
  username?: string;
  global_name?: string | null;
  /** True for bots and webhooks. Used to skip the bot's own echoes. */
  bot?: boolean;
};

export type DiscordAttachment = {
  id: string;
  filename?: string;
  content_type?: string;
};

export type DiscordMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordAuthor;
  content?: string;
  attachments?: DiscordAttachment[];
  /** ISO 8601. Discord's own timestamp, preferred over arrival time. */
  timestamp?: string;
  /** 0 = DEFAULT, 19 = REPLY. Other values are joins, pins, system notices. */
  type?: number;
};

/** What scripts/discord-gateway.mjs POSTs to /api/discord-ingest. */
export type DiscordIngestPayload = {
  channelName?: string;
  guildName?: string;
  messages: DiscordMessage[];
};
