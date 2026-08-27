import type { BotSystemConfig, TenantChannelConfig, TenantConfig } from './types.js';

const defaultTenantId = process.env.DEFAULT_TENANT_ID || 'demo';
const defaultLineChannelId = process.env.DEFAULT_LINE_CHANNEL_ID || 'default-line';

const defaultBotSystem: BotSystemConfig = process.env.BOT_SYSTEM_KIND === 'mcp_agent' && process.env.MCP_ENDPOINT
  ? {
      kind: 'mcp_agent',
      mcpEndpoint: process.env.MCP_ENDPOINT,
      systemPrompt: process.env.MCP_SYSTEM_PROMPT,
      allowedTools: process.env.MCP_ALLOWED_TOOLS?.split(',').map((tool) => tool.trim()).filter(Boolean),
    }
  : { kind: 'group_translator' };

const tenants = new Map<string, TenantConfig>([
  [defaultTenantId, {
    id: defaultTenantId,
    name: 'Tecxbot Demo',
    defaultLanguage: 'zh-TW',
    domainContext: 'General business chat automation. Avoid domain-specific claims unless configured by the tenant.',
    botMentionNames: ['tecxbot', 'tecxmate', 'tecxmate.com', 'bot'],
    freePlan: {
      id: 'free',
      name: 'Free trial',
      characterLimit: Number(process.env.FREE_CHARACTER_LIMIT || 5000),
    },
    botSystem: defaultBotSystem,
  }],
]);

const lineChannels = new Map<string, TenantChannelConfig>([
  [defaultLineChannelId, {
    id: defaultLineChannelId,
    tenantId: defaultTenantId,
    platform: 'line',
    label: 'Default LINE channel',
    botSystem: defaultBotSystem,
    line: {
      channelSecret: process.env.LINE_CHANNEL_SECRET || '',
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    },
  }],
]);

// Vietnamy teacher bot — a separate LINE channel with its own credentials.
// Only registered when its access token is configured, so the existing
// translation bot keeps working untouched when these env vars are absent.
const vnTenantId = process.env.VN_TENANT_ID || 'vnmy';
const vnChannelId = process.env.VN_LINE_CHANNEL_ID || 'vn-teacher';

if (process.env.VN_LINE_CHANNEL_ACCESS_TOKEN) {
  const vnBotSystem: BotSystemConfig = {
    kind: 'vietnamese_teacher',
    appName: process.env.VN_APP_NAME || 'Vietnamy',
    appTagline: process.env.VN_APP_TAGLINE || 'Learn Vietnamese through interactive lessons, spaced repetition, a multi-source dictionary, grammar drills, and gamification — built for English and Chinese speakers.',
    appUrl: process.env.VN_APP_URL || 'https://vietnamy.com',
  };
  tenants.set(vnTenantId, {
    id: vnTenantId,
    name: process.env.VN_APP_NAME || 'Vietnamy',
    defaultLanguage: 'en',
    domainContext: 'Vietnamese language learning for English and Chinese speakers.',
    botMentionNames: (process.env.VN_BOT_MENTION_NAMES || 'vietnamy,teacher,vnmy,bot').split(',').map((name) => name.trim()).filter(Boolean),
    freePlan: { id: 'free', name: 'Free', characterLimit: Number(process.env.FREE_CHARACTER_LIMIT || 5000) },
    botSystem: vnBotSystem,
  });
  lineChannels.set(vnChannelId, {
    id: vnChannelId,
    tenantId: vnTenantId,
    platform: 'line',
    label: 'Vietnamy teacher LINE channel',
    botSystem: vnBotSystem,
    line: {
      channelSecret: process.env.VN_LINE_CHANNEL_SECRET || '',
      channelAccessToken: process.env.VN_LINE_CHANNEL_ACCESS_TOKEN,
    },
  });
}

// Tecxmate client bot — a separate LINE channel that fronts client groups.
// It ingests recent group chat as context and dispatches tasks to Linear, which
// the local coding agent in tecxcorp picks up. Only registered when its access
// token is configured, so the other bots keep working untouched without it.
const tecxmateTenantId = process.env.TECXMATE_TENANT_ID || 'tecxmate';
const tecxmateChannelId = process.env.TECXMATE_LINE_CHANNEL_ID || 'tecxmate';

if (process.env.TECXMATE_LINE_CHANNEL_ACCESS_TOKEN) {
  const tecxmateBotSystem: BotSystemConfig = {
    kind: 'tecxmate',
    companyName: process.env.TECXMATE_COMPANY_NAME || 'TECXMATE',
    ownerUserIds: (process.env.TECXMATE_OWNER_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean),
  };
  tenants.set(tecxmateTenantId, {
    id: tecxmateTenantId,
    name: process.env.TECXMATE_COMPANY_NAME || 'TECXMATE',
    defaultLanguage: 'en',
    domainContext: 'Client-facing assistant for TECXMATE document and contract operations.',
    botMentionNames: (process.env.TECXMATE_BOT_MENTION_NAMES || 'tecxmate,mate,bot').split(',').map((name) => name.trim()).filter(Boolean),
    freePlan: { id: 'free', name: 'Free', characterLimit: Number(process.env.FREE_CHARACTER_LIMIT || 5000) },
    botSystem: tecxmateBotSystem,
  });
  lineChannels.set(tecxmateChannelId, {
    id: tecxmateChannelId,
    tenantId: tecxmateTenantId,
    platform: 'line',
    label: 'Tecxmate client LINE channel',
    botSystem: tecxmateBotSystem,
    line: {
      channelSecret: process.env.TECXMATE_LINE_CHANNEL_SECRET || '',
      channelAccessToken: process.env.TECXMATE_LINE_CHANNEL_ACCESS_TOKEN,
    },
  });
}

// WhatsApp Business (Meta Cloud API) — ingest-only today: inbound messages are
// captured for the Claude connector, and no bot replies on WhatsApp. Registered
// only when a phone number id is configured, so LINE keeps working without it.
const whatsappChannels = new Map<string, TenantChannelConfig>();
const whatsappTenantId = process.env.WHATSAPP_TENANT_ID || defaultTenantId;
const whatsappChannelId = process.env.WHATSAPP_CHANNEL_ID || 'default-whatsapp';

if (process.env.WHATSAPP_PHONE_NUMBER_ID) {
  whatsappChannels.set(whatsappChannelId, {
    id: whatsappChannelId,
    tenantId: whatsappTenantId,
    platform: 'whatsapp',
    label: 'WhatsApp Business channel',
    botSystem: { kind: 'group_translator' },
    whatsapp: {
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
      appSecret: process.env.WHATSAPP_APP_SECRET,
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
      displayPhoneNumber: process.env.WHATSAPP_DISPLAY_PHONE_NUMBER,
    },
  });
}

// Claude assistant bot — "Claude in LINE". A channel answers with the captured
// client conversation as context. Registered only when its access token is set,
// so nothing else changes when these env vars are absent.
const claudeTenantId = process.env.CLAUDE_ASSISTANT_TENANT_ID || defaultTenantId;
const claudeChannelId = process.env.CLAUDE_ASSISTANT_LINE_CHANNEL_ID || 'claude-assistant';

if (process.env.CLAUDE_ASSISTANT_LINE_CHANNEL_ACCESS_TOKEN) {
  const claudeBotSystem: BotSystemConfig = {
    kind: 'claude_assistant',
    ownerUserIds: (process.env.CLAUDE_ASSISTANT_OWNER_USER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean),
    allowGroups: process.env.CLAUDE_ASSISTANT_ALLOW_GROUPS === 'true',
    systemPrompt: process.env.CLAUDE_ASSISTANT_SYSTEM_PROMPT || undefined,
    contextConversationId: process.env.CLAUDE_ASSISTANT_CONTEXT_CONVERSATION_ID || undefined,
    contextMessages: process.env.CLAUDE_ASSISTANT_CONTEXT_MESSAGES ? Number(process.env.CLAUDE_ASSISTANT_CONTEXT_MESSAGES) : undefined,
  };
  tenants.set(claudeTenantId, tenants.get(claudeTenantId) ?? {
    id: claudeTenantId,
    name: process.env.CLAUDE_ASSISTANT_NAME || 'TECXMATE',
    defaultLanguage: 'en',
    domainContext: 'Client-facing assistant answering from captured conversation context.',
    botMentionNames: (process.env.CLAUDE_ASSISTANT_BOT_MENTION_NAMES || 'tecxmate,mate,bot').split(',').map((name) => name.trim()).filter(Boolean),
    freePlan: { id: 'free', name: 'Free', characterLimit: Number(process.env.FREE_CHARACTER_LIMIT || 5000) },
    botSystem: claudeBotSystem,
  });
  lineChannels.set(claudeChannelId, {
    id: claudeChannelId,
    tenantId: claudeTenantId,
    platform: 'line',
    label: 'Claude assistant LINE channel',
    botSystem: claudeBotSystem,
    line: {
      channelSecret: process.env.CLAUDE_ASSISTANT_LINE_CHANNEL_SECRET || '',
      channelAccessToken: process.env.CLAUDE_ASSISTANT_LINE_CHANNEL_ACCESS_TOKEN,
    },
  });
}

export function getTenantConfig(tenantId = defaultTenantId): TenantConfig {
  return tenants.get(tenantId) ?? tenants.get(defaultTenantId)!;
}

export function getTenantChannelConfig(channelId = defaultLineChannelId): TenantChannelConfig {
  const channel = lineChannels.get(channelId);
  if (!channel) throw new Error('No LINE channel configured');
  return channel;
}

export function resolveTenantChannel(input: { tenantId?: string; channelId?: string }) {
  const channel = getTenantChannelConfig(input.channelId ?? defaultLineChannelId);
  const tenant = getTenantConfig(input.tenantId ?? channel.tenantId);
  return { tenant, channel: { ...channel, botSystem: channel.botSystem ?? tenant.botSystem } };
}

/**
 * Resolve the WhatsApp channel an inbound webhook belongs to. Meta identifies
 * the receiving number by `phone_number_id`, so that is the primary key and the
 * explicit `?channel=` query is the override.
 */
export function resolveWhatsappChannel(input: { channelId?: string; phoneNumberId?: string }) {
  const channel = (input.channelId ? whatsappChannels.get(input.channelId) : undefined)
    ?? (input.phoneNumberId ? [...whatsappChannels.values()].find((item) => item.whatsapp?.phoneNumberId === input.phoneNumberId) : undefined);
  if (!channel) return undefined;
  return { tenant: getTenantConfig(channel.tenantId), channel };
}

export function listWhatsappChannels() {
  return [...whatsappChannels.values()];
}

/** Channel inventory reported by the connector's `connector_status` tool. */
export function listConnectorChannels() {
  return [...lineChannels.values(), ...whatsappChannels.values()].map((channel) => ({
    id: channel.id,
    platform: channel.platform,
    label: channel.label,
    tenantId: channel.tenantId,
  }));
}
