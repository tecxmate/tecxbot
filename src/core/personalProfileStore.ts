export type PersonalTone = 'concise' | 'balanced' | 'technical';
export type PersonalLanguage = 'en' | 'tw';
export type PersonalRisk = 'conservative' | 'balanced' | 'aggressive';
export type WatchlistBriefTemplate = 'premarket' | 'midday' | 'postclose' | 'risk' | 'news' | 'flow';

export type PersonalWatchItem = {
  ticker: string;
  reason?: string;
  companyName?: string;
  pillar?: string;
  node?: string;
  addedAt: number;
  updatedAt: number;
};

export type WatchlistBriefReminder = {
  id: string;
  time: string;
  timezone: string;
  template: WatchlistBriefTemplate;
  enabled: boolean;
  lastSentDate?: string;
  createdAt: number;
  updatedAt: number;
};

export type PersonalProfile = {
  tenantId: string;
  channelId: string;
  platform: 'line';
  userId: string;
  language: PersonalLanguage;
  tone: PersonalTone;
  risk: PersonalRisk;
  watchlist: PersonalWatchItem[];
  briefReminders: WatchlistBriefReminder[];
  createdAt: number;
  updatedAt: number;
};

type ProfileKeyInput = {
  tenantId: string;
  channelId: string;
  platform: 'line';
  userId: string;
};

const profiles = new Map<string, PersonalProfile>();

export function getPersonalProfile(input: ProfileKeyInput): PersonalProfile {
  const key = profileKey(input);
  const existing = profiles.get(key);
  if (existing) return existing;
  const now = Date.now();
  const profile: PersonalProfile = {
    tenantId: input.tenantId,
    channelId: input.channelId,
    platform: input.platform,
    userId: input.userId,
    language: 'tw',
    tone: 'balanced',
    risk: 'balanced',
    watchlist: [],
    briefReminders: [],
    createdAt: now,
    updatedAt: now,
  };
  profiles.set(key, profile);
  return profile;
}

export function setPersonalPreferences(input: ProfileKeyInput & { language?: PersonalLanguage; tone?: PersonalTone; risk?: PersonalRisk }) {
  const profile = getPersonalProfile(input);
  if (input.language) profile.language = input.language;
  if (input.tone) profile.tone = input.tone;
  if (input.risk) profile.risk = input.risk;
  profile.updatedAt = Date.now();
  return profile;
}

export function addPersonalWatchItem(input: ProfileKeyInput & Omit<PersonalWatchItem, 'addedAt' | 'updatedAt'>) {
  const profile = getPersonalProfile(input);
  const now = Date.now();
  const existing = profile.watchlist.find((item) => item.ticker === input.ticker);
  if (existing) {
    existing.reason = input.reason ?? existing.reason;
    existing.companyName = input.companyName ?? existing.companyName;
    existing.pillar = input.pillar ?? existing.pillar;
    existing.node = input.node ?? existing.node;
    existing.updatedAt = now;
  } else {
    profile.watchlist.push({
      ticker: input.ticker,
      reason: input.reason,
      companyName: input.companyName,
      pillar: input.pillar,
      node: input.node,
      addedAt: now,
      updatedAt: now,
    });
  }
  profile.watchlist.sort((a, b) => b.updatedAt - a.updatedAt);
  profile.updatedAt = now;
  return profile;
}

export function removePersonalWatchItem(input: ProfileKeyInput & { ticker: string }) {
  const profile = getPersonalProfile(input);
  const before = profile.watchlist.length;
  profile.watchlist = profile.watchlist.filter((item) => item.ticker !== input.ticker);
  profile.updatedAt = Date.now();
  return { profile, removed: profile.watchlist.length !== before };
}

export function upsertBriefReminder(input: ProfileKeyInput & { id?: string; time: string; template: WatchlistBriefTemplate; timezone?: string; enabled?: boolean }) {
  const profile = getPersonalProfile(input);
  const now = Date.now();
  const existing = input.id ? profile.briefReminders.find((item) => item.id === input.id) : undefined;
  if (existing) {
    existing.time = input.time;
    existing.template = input.template;
    existing.timezone = input.timezone ?? existing.timezone;
    existing.enabled = input.enabled ?? existing.enabled;
    existing.updatedAt = now;
  } else {
    profile.briefReminders.push({
      id: createReminderId(),
      time: input.time,
      timezone: input.timezone ?? 'Asia/Taipei',
      template: input.template,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    });
  }
  profile.briefReminders.sort((a, b) => a.time.localeCompare(b.time));
  profile.updatedAt = now;
  return profile;
}

export function setBriefReminderEnabled(input: ProfileKeyInput & { id: string; enabled: boolean }) {
  const profile = getPersonalProfile(input);
  const reminder = profile.briefReminders.find((item) => item.id === input.id);
  if (!reminder) return { profile, updated: false };
  reminder.enabled = input.enabled;
  reminder.updatedAt = Date.now();
  profile.updatedAt = reminder.updatedAt;
  return { profile, updated: true };
}

export function removeBriefReminder(input: ProfileKeyInput & { id: string }) {
  const profile = getPersonalProfile(input);
  const before = profile.briefReminders.length;
  profile.briefReminders = profile.briefReminders.filter((item) => item.id !== input.id);
  profile.updatedAt = Date.now();
  return { profile, removed: profile.briefReminders.length !== before };
}

export function listProfiles() {
  return Array.from(profiles.values());
}

export function getDueBriefReminders(input: { now?: Date; tenantId?: string; channelId?: string }) {
  const now = input.now ?? new Date();
  const due: Array<{ profile: PersonalProfile; reminder: WatchlistBriefReminder; localDate: string }> = [];
  for (const profile of profiles.values()) {
    if (input.tenantId && profile.tenantId !== input.tenantId) continue;
    if (input.channelId && profile.channelId !== input.channelId) continue;
    for (const reminder of profile.briefReminders) {
      if (!reminder.enabled) continue;
      const local = getLocalDateTime(now, reminder.timezone);
      if (local.time !== reminder.time) continue;
      if (reminder.lastSentDate === local.date) continue;
      due.push({ profile, reminder, localDate: local.date });
    }
  }
  return due;
}

export function markBriefReminderSent(input: ProfileKeyInput & { reminderId: string; localDate: string }) {
  const profile = getPersonalProfile(input);
  const reminder = profile.briefReminders.find((item) => item.id === input.reminderId);
  if (!reminder) return false;
  reminder.lastSentDate = input.localDate;
  reminder.updatedAt = Date.now();
  profile.updatedAt = reminder.updatedAt;
  return true;
}

function profileKey(input: ProfileKeyInput) {
  return `${input.tenantId}:${input.channelId}:${input.platform}:${input.userId}`;
}

function createReminderId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getLocalDateTime(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
  };
}
