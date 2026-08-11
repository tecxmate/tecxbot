export type Platform = 'line' | 'facebook' | 'telegram' | 'whatsapp' | 'zalo' | 'web';

export type BotSystemKind = 'group_translator' | 'mcp_agent' | 'vietnamese_teacher' | 'tecxmate';

export type TenantConfig = {
  id: string;
  name: string;
  defaultLanguage: 'zh-TW' | 'en';
  domainContext: string;
  botMentionNames: string[];
  freePlan: TenantPlan;
  botSystem: BotSystemConfig;
};

export type BotSystemConfig =
  | {
      kind: 'group_translator';
    }
  | {
      kind: 'mcp_agent';
      mcpEndpoint: string;
      systemPrompt?: string;
      allowedTools?: string[];
    }
  | {
      kind: 'vietnamese_teacher';
      appName: string;
      appTagline?: string;
      appUrl?: string;
    }
  | {
      kind: 'tecxmate';
      companyName: string;
      // LINE user ids allowed to dispatch tasks. Empty = personal deployment
      // where anyone who can tag the bot is treated as the owner.
      ownerUserIds: string[];
    };

export type TenantChannelConfig = {
  id: string;
  tenantId: string;
  platform: Platform;
  label: string;
  botSystem: BotSystemConfig;
  line?: LineChannelConfig;
  whatsapp?: WhatsappChannelConfig;
};

export type LineChannelConfig = {
  channelSecret: string;
  channelAccessToken: string;
};

// WhatsApp Business Platform (Meta Cloud API). The connector only needs to read
// inbound traffic, so `accessToken` is optional — it is required to send.
export type WhatsappChannelConfig = {
  phoneNumberId: string;
  accessToken?: string;
  appSecret?: string;
  verifyToken?: string;
  displayPhoneNumber?: string;
};

export type TenantPlan = {
  id: string;
  name: string;
  characterLimit: number;
  stripePriceId?: string;
};

export type ReplyButton = {
  label: string;
  data?: string;
  url?: string;
  text?: string;
};

export type BotReply = {
  text: string;
  buttons?: ReplyButton[][];
  imageUrl?: string;
};

export type TranscriptLanguage = 'en' | 'zh-TW';
