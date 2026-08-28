// Outbound half of the connector: let Claude (acting as the TECXMATE PM) post a
// reply back into a LINE conversation.
//
// The rest of the connector is deliberately read-only. This is the one place it
// can write to a messaging platform, and it is fail-closed: nothing here sends
// unless CONNECTOR_ALLOW_REPLY=true is set. The reasoning ("what should the PM
// say?") happens in the connected Claude client on the operator's own plan — no
// Anthropic API key is used here. The LINE channel access token used to deliver
// the message is the bot's own messaging credential (needed to send any LINE
// message at all), never an AI key, and it stays server-side.

import { getConversation, recordMessage } from '../core/conversationStore.js';
import { getTenantChannelConfig } from '../core/tenantStore.js';
import { pushLineMessage } from '../platforms/line/client.js';

/** Fail closed: replying is off unless explicitly enabled. */
export function isReplyEnabled(): boolean {
  return (process.env.CONNECTOR_ALLOW_REPLY ?? '').trim().toLowerCase() === 'true';
}

/** Display name recorded (and understood by the PM) for outbound replies. */
export function replySenderName(): string {
  return process.env.CONNECTOR_REPLY_SENDER_NAME?.trim() || 'TECXMATE PM';
}

/**
 * Optional allowlist of conversation ids the PM may reply to. When set, only
 * those conversations are writable — so enabling replies for the client group
 * can't be turned into posting anywhere captured. Empty = any LINE conversation.
 */
export function replyAllowlist(): string[] {
  return (process.env.CONNECTOR_REPLY_CONVERSATION_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export function isConversationReplyable(conversationId: string): boolean {
  const allow = replyAllowlist();
  return allow.length === 0 || allow.includes(conversationId);
}

export type ReplyReason = 'disabled' | 'empty' | 'not_found' | 'not_line' | 'not_allowed' | 'no_token';
export type ReplyOutcome = { ok: true; to: string; at: number } | { ok: false; reason: ReplyReason };

/**
 * Send a text reply into a LINE conversation and record it as an outbound
 * message so the transcript stays coherent and the PM can see it already
 * answered. Every gate returns before any network call, so a misconfigured
 * deployment fails safe rather than sending.
 */
export async function sendLineReply(input: { conversationId: string; text: string; tenantId?: string }): Promise<ReplyOutcome> {
  if (!isReplyEnabled()) return { ok: false, reason: 'disabled' };
  const text = input.text.trim();
  if (!text) return { ok: false, reason: 'empty' };

  const conversation = await getConversation(input.conversationId, input.tenantId);
  if (!conversation) return { ok: false, reason: 'not_found' };
  if (conversation.platform !== 'line') return { ok: false, reason: 'not_line' };
  if (!isConversationReplyable(conversation.conversationId)) return { ok: false, reason: 'not_allowed' };

  const token = channelToken(conversation.channelId);
  if (!token) return { ok: false, reason: 'no_token' };

  const to = conversation.externalConversationId;
  await pushLineMessage(to, { text }, token);
  const at = Date.now();

  // Best-effort: a failed capture must not make the tool report a send failure
  // when the message actually went out.
  try {
    await recordMessage({
      tenantId: conversation.tenantId,
      channelId: conversation.channelId,
      platform: 'line',
      conversationType: conversation.conversationType,
      externalConversationId: conversation.externalConversationId,
      title: conversation.title,
      direction: 'outbound',
      senderName: replySenderName(),
      text,
      messageType: 'text',
      // Synthetic id (not a real LINE message id) — keeps the idempotency index
      // happy and marks this as a PM reply rather than fetchable media.
      externalMessageId: `pm-reply:${at}:${Math.random().toString(36).slice(2, 8)}`,
      at,
    });
  } catch (error) {
    console.error('[connector-reply] sent but failed to record outbound reply:', error);
  }

  return { ok: true, to, at };
}

function channelToken(channelId: string): string | undefined {
  try {
    return getTenantChannelConfig(channelId).line?.channelAccessToken || undefined;
  } catch {
    return undefined;
  }
}
