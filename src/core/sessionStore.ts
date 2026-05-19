import type { Platform, TranscriptLanguage } from './types.js';

export type SessionMessage = { role: 'user' | 'assistant'; text: string; at: number };
export type AudioArtifact = { platformMessageId: string; mediaType: 'audio' | 'video' | 'file'; fileName?: string; fileSize?: number; durationMs?: number; createdAt: number };
export type TranscriptArtifact = { rawText: string; language: TranscriptLanguage; createdAt: number };

export type ConversationSession = {
  key: string;
  tenantId: string;
  platform: Platform;
  sourceType: 'user' | 'group' | 'room';
  sourceId: string;
  userId?: string;
  status: 'active' | 'closed';
  currentWorkflow?: string;
  currentStep?: string;
  lastActivityAt: number;
  messages: SessionMessage[];
  audio?: AudioArtifact;
  transcript?: TranscriptArtifact;
};

const sessions = new Map<string, ConversationSession>();
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_MESSAGES = 10;

export function getSession(input: { tenantId: string; platform: Platform; sourceType: 'user' | 'group' | 'room'; sourceId: string; userId?: string }) {
  cleanupSessions();
  const key = `${input.tenantId}:${input.platform}:${input.sourceType}:${input.sourceId}:${input.sourceType === 'user' ? 'direct' : input.userId ?? 'unknown'}`;
  const now = Date.now();
  const existing = sessions.get(key);
  if (existing) {
    existing.lastActivityAt = now;
    existing.status = 'active';
    return existing;
  }
  const session: ConversationSession = { ...input, key, status: 'active', lastActivityAt: now, messages: [] };
  sessions.set(key, session);
  return session;
}

export function appendMessage(session: ConversationSession, role: SessionMessage['role'], text: string) {
  session.messages.push({ role, text: text.slice(0, 1200), at: Date.now() });
  session.messages = session.messages.slice(-MAX_MESSAGES);
  session.lastActivityAt = Date.now();
}

export function closeSession(session: ConversationSession) {
  session.status = 'closed';
  session.currentWorkflow = undefined;
  session.currentStep = undefined;
}

export function isSessionActive(session: ConversationSession, windowMs = 5 * 60 * 1000) {
  return session.status === 'active' && session.messages.length > 0 && Date.now() - session.lastActivityAt <= windowMs;
}

function cleanupSessions() {
  const now = Date.now();
  for (const [key, session] of sessions.entries()) {
    if (now - session.lastActivityAt > SESSION_TTL_MS) sessions.delete(key);
  }
}
