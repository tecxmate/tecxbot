export type Platform = 'line' | 'facebook' | 'telegram' | 'whatsapp' | 'zalo' | 'web';

export type BotSystemKind = 'group_translator' | 'mcp_agent' | 'vietnamese_teacher';

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
    };

export type TenantChannelConfig = {
  id: string;
  tenantId: string;
  platform: Platform;
  label: string;
  botSystem: BotSystemConfig;
  line?: LineChannelConfig;
};

export type LineChannelConfig = {
  channelSecret: string;
  channelAccessToken: string;
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
