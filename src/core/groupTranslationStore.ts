import { normalizeLanguageCode } from './languages.js';

export type GroupTranslationSettings = {
  tenantId: string;
  platform: 'line';
  groupId: string;
  targetLanguages: string[];
  disabledUserIds: string[];
  recentMessages: GroupContextMessage[];
  updatedAt: number;
};

export type GroupContextMessage = {
  userId?: string;
  text: string;
  at: number;
};

const groupSettings = new Map<string, GroupTranslationSettings>();
const MAX_CONTEXT_MESSAGES = 80;

export function getGroupTranslationSettings(input: { tenantId: string; platform: 'line'; groupId: string }) {
  return groupSettings.get(key(input));
}

export function setGroupTranslationLanguages(input: { tenantId: string; platform: 'line'; groupId: string; languageCodes: string[] }) {
  const normalized = Array.from(new Set(input.languageCodes.map(normalizeLanguageCode).filter((code): code is string => Boolean(code))));
  const settings = getGroupTranslationSettings(input) ?? {
    tenantId: input.tenantId,
    platform: input.platform,
    groupId: input.groupId,
    targetLanguages: [],
    disabledUserIds: [],
    recentMessages: [],
    updatedAt: Date.now(),
  };
  settings.targetLanguages = normalized;
  settings.updatedAt = Date.now();
  groupSettings.set(key(input), settings);
  return settings;
}

export function setUserTranslationEnabled(input: { tenantId: string; platform: 'line'; groupId: string; userId: string; enabled: boolean }) {
  const settings = getGroupTranslationSettings(input);
  if (!settings) return undefined;
  const disabled = new Set(settings.disabledUserIds);
  if (input.enabled) disabled.delete(input.userId);
  else disabled.add(input.userId);
  settings.disabledUserIds = Array.from(disabled);
  settings.updatedAt = Date.now();
  return settings;
}

export function isUserTranslationEnabled(settings: GroupTranslationSettings, userId?: string) {
  return typeof userId === 'string' && !settings.disabledUserIds.includes(userId);
}

export function appendGroupContextMessage(settings: GroupTranslationSettings, input: { userId?: string; text: string }) {
  settings.recentMessages.push({ userId: input.userId, text: input.text.slice(0, 1200), at: Date.now() });
  settings.recentMessages = settings.recentMessages.slice(-MAX_CONTEXT_MESSAGES);
  settings.updatedAt = Date.now();
}

function key(input: { tenantId: string; platform: 'line'; groupId: string }) {
  return `${input.tenantId}:${input.platform}:${input.groupId}`;
}
