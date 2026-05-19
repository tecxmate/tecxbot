export type Platform = 'line' | 'telegram' | 'whatsapp' | 'zalo' | 'web';

export type TenantConfig = {
  id: string;
  name: string;
  defaultLanguage: 'zh-TW' | 'en';
  domainContext: string;
  botMentionNames: string[];
};

export type ReplyButton = {
  label: string;
  data?: string;
  url?: string;
};

export type BotReply = {
  text: string;
  buttons?: ReplyButton[][];
};

export type TranscriptLanguage = 'en' | 'zh-TW';
