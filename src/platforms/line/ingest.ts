// Captures LINE traffic into the connector's conversation log.
//
// This runs for every LINE channel regardless of which bot system handles the
// event — the translator, the Vietnamese teacher, the tecxmate operator bot —
// because the connector's job is to hand Claude the client conversation, not
// whatever one bot happened to do with it.
//
// Everything here is best-effort by design. A capture failure must never cost a
// client their reply, so errors are logged and swallowed.

import { isCaptureEnabled, recordMessage, type ConversationType } from '../../core/conversationStore.js';
import type { BotReply } from '../../core/types.js';
import { fetchLineDisplayName, fetchLineGroupName } from './client.js';
import type { LineEvent, LineMessage, LineSource } from './types.js';
import type { LineWebhookRuntime } from './webhook.js';

type ConversationTarget = { conversationType: ConversationType; externalConversationId: string };

export async function captureLineInbound(event: LineEvent, runtime: LineWebhookRuntime) {
  if (!isCaptureEnabled()) return;
  if (event.type !== 'message' || !('message' in event)) return;
  const target = resolveTarget(event.source);
  if (!target) return;
  const described = describeMessage(event.message);
  if (!described) return;
  try {
    const [title, senderName] = await Promise.all([
      resolveTitle(target, event.source, runtime),
      resolveSenderName(event.source, runtime),
    ]);
    await recordMessage({
      tenantId: runtime.tenant.id,
      channelId: runtime.channel.id,
      platform: 'line',
      ...target,
      title,
      direction: 'inbound',
      senderId: event.source?.userId,
      senderName,
      text: described.text,
      messageType: described.messageType,
      externalMessageId: event.message.id,
    });
  } catch (error) {
    console.error('[line-ingest] Failed to capture inbound message:', error);
  }
}

export async function captureLineOutbound(event: LineEvent, reply: BotReply, runtime: LineWebhookRuntime) {
  if (!isCaptureEnabled()) return;
  const target = resolveTarget(event.source);
  if (!target || !reply.text.trim()) return;
  // LINE does not return an id for a reply, so derive a deterministic one from
  // the event that triggered it — a redelivered webhook then collapses onto the
  // same row instead of appending a second copy of the bot's answer.
  const sourceId = event.type === 'message' && 'message' in event ? event.message.id : 'replyToken' in event ? event.replyToken : undefined;
  try {
    await recordMessage({
      tenantId: runtime.tenant.id,
      channelId: runtime.channel.id,
      platform: 'line',
      ...target,
      direction: 'outbound',
      senderName: runtime.tenant.name,
      text: reply.text,
      messageType: 'text',
      externalMessageId: sourceId ? `reply:${sourceId}` : undefined,
    });
  } catch (error) {
    console.error('[line-ingest] Failed to capture outbound message:', error);
  }
}

function resolveTarget(source: LineSource | undefined): ConversationTarget | undefined {
  if (!source) return undefined;
  if (source.type === 'group' && source.groupId) return { conversationType: 'group', externalConversationId: source.groupId };
  if (source.type === 'room' && source.roomId) return { conversationType: 'room', externalConversationId: source.roomId };
  if (source.userId) return { conversationType: 'direct', externalConversationId: source.userId };
  return undefined;
}

function describeMessage(message: LineMessage): { text: string; messageType: string } | undefined {
  if (message.type === 'text') {
    const text = message.text?.trim();
    return text ? { text, messageType: 'text' } : undefined;
  }
  // Non-text messages still matter as context ("they sent the signed PDF at
  // 4pm"), so they are logged as a short placeholder rather than dropped.
  if (message.type === 'audio') return { text: message.duration ? `[voice message · ${Math.round(message.duration / 1000)}s]` : '[voice message]', messageType: 'audio' };
  if (message.type === 'video') return { text: '[video]', messageType: 'video' };
  if (message.type === 'file') return { text: `[file: ${message.fileName ?? 'unnamed'}]`, messageType: 'file' };
  if (message.type === 'image') return { text: '[image]', messageType: 'image' };
  if (message.type === 'sticker') return { text: '[sticker]', messageType: 'sticker' };
  if (message.type === 'location') return { text: '[location]', messageType: 'location' };
  return undefined;
}

async function resolveTitle(target: ConversationTarget, source: LineSource | undefined, runtime: LineWebhookRuntime): Promise<string | undefined> {
  const token = runtime.channel.line?.channelAccessToken;
  if (target.conversationType === 'group') {
    return cached(`group:${target.externalConversationId}`, () => fetchLineGroupName(target.externalConversationId, token));
  }
  // Rooms have no summary endpoint, so a multi-person room stays labelled by id.
  if (target.conversationType === 'room') return undefined;
  if (!source?.userId) return undefined;
  return cached(`user:${source.userId}`, () => fetchLineDisplayName({ userId: source.userId! }, token));
}

async function resolveSenderName(source: LineSource | undefined, runtime: LineWebhookRuntime): Promise<string | undefined> {
  if (!source?.userId) return undefined;
  const token = runtime.channel.line?.channelAccessToken;
  const key = `member:${source.groupId ?? source.roomId ?? 'direct'}:${source.userId}`;
  return cached(key, () => fetchLineDisplayName({ userId: source.userId!, groupId: source.groupId, roomId: source.roomId }, token));
}

// Display names change rarely and every lookup is a round trip on the reply
// path, so cache them per warm instance.
const NAME_TTL_MS = 60 * 60 * 1000;
const NAME_CACHE_MAX = 500;
const nameCache = new Map<string, { value?: string; at: number }>();

async function cached(key: string, load: () => Promise<string | undefined>): Promise<string | undefined> {
  const hit = nameCache.get(key);
  if (hit && Date.now() - hit.at < NAME_TTL_MS) return hit.value;
  const value = await load();
  if (nameCache.size >= NAME_CACHE_MAX) {
    const oldest = [...nameCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, Math.ceil(NAME_CACHE_MAX / 4));
    for (const [staleKey] of oldest) nameCache.delete(staleKey);
  }
  nameCache.set(key, { value, at: Date.now() });
  return value;
}
