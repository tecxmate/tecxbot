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
