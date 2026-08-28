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

import { countReplyPushesSince, getConversation, recordMessage, REPLY_PUSH_PREFIX, type ConversationSummary } from '../core/conversationStore.js';
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
 * Review (draft-for-approval) mode. When a review conversation id is set, a
 * reply is never delivered to the client: instead the draft is posted into this
 * internal group (e.g. tecx-exec) for a human to read and approve. This is an
 * enforced gate — in review mode there is no code path from the PM to a client
 * conversation, so approval can't be skipped. Unset = direct send.
 */
export function reviewConversationId(): string | undefined {
  return process.env.CONNECTOR_REVIEW_CONVERSATION_ID?.trim() || undefined;
}

export function isReviewMode(): boolean {
  return Boolean(reviewConversationId());
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

/**
 * Monthly push cap — a hard backstop on LINE quota. Every send_line_reply call
 * is a LINE push (to the client, or the review group), and LINE's free tier is
 * limited (~200/month in Taiwan). With CONNECTOR_REPLY_MONTHLY_CAP set to a
 * positive integer, the tool refuses once that many pushes have been recorded in
 * the current calendar month. 0 / unset = no cap. The count is of the pm-reply
 * markers in the durable log, so it survives restarts (on the memory store it
 * resets on cold start, which is fine for dev).
 */
export function monthlyCap(): number | undefined {
  const raw = Number(process.env.CONNECTOR_REPLY_MONTHLY_CAP ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

/** Start of the current calendar month, UTC (an approximation of LINE's cycle). */
export function monthStartMs(now = new Date()): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/** Pushes used this month and the configured cap, for status/reporting. */
export async function replyQuota(): Promise<{ cap?: number; used: number }> {
  return { cap: monthlyCap(), used: await countReplyPushesSince(monthStartMs()) };
}

export type ReplyReason =
  | 'disabled' | 'empty' | 'not_found' | 'not_line' | 'not_allowed' | 'no_token'
  | 'review_not_found' | 'review_not_line' | 'review_no_token' | 'over_cap';
export type ReplyOutcome =
  | { ok: true; mode: 'direct'; conversationId: string; to: string; at: number }
  | { ok: true; mode: 'review'; conversationId: string; reviewConversationId: string; to: string; at: number }
  | { ok: false; reason: ReplyReason; used?: number; cap?: number };

/**
 * Send the PM's reply. In direct mode it is delivered to the client conversation
 * and recorded as outbound. In review mode (CONNECTOR_REVIEW_CONVERSATION_ID
 * set) it is instead posted as a draft into the internal review group for a
 * human to approve — the client conversation is never written to. Every gate
 * returns before any network call, so a misconfigured deployment fails safe.
 */
export async function sendLineReply(input: { conversationId: string; text: string; tenantId?: string }): Promise<ReplyOutcome> {
  if (!isReplyEnabled()) return { ok: false, reason: 'disabled' };
  const text = input.text.trim();
  if (!text) return { ok: false, reason: 'empty' };

  const target = await getConversation(input.conversationId, input.tenantId);
  if (!target) return { ok: false, reason: 'not_found' };
  if (target.platform !== 'line') return { ok: false, reason: 'not_line' };
  if (!isConversationReplyable(target.conversationId)) return { ok: false, reason: 'not_allowed' };

  // Hard LINE-quota backstop: refuse once the month's push budget is spent. Both
  // modes below push exactly once, so the check belongs here, before either.
  const cap = monthlyCap();
  if (cap !== undefined) {
    const used = await countReplyPushesSince(monthStartMs());
    if (used >= cap) return { ok: false, reason: 'over_cap', used, cap };
  }

  const reviewId = reviewConversationId();
  if (reviewId) return draftForReview(target, text, reviewId, input.tenantId);
  return deliverDirect(target, text);
}

// Direct: deliver to the client conversation and record it as outbound.
async function deliverDirect(target: ConversationSummary, text: string): Promise<ReplyOutcome> {
  const token = channelToken(target.channelId);
  if (!token) return { ok: false, reason: 'no_token' };

  const to = target.externalConversationId;
  await pushLineMessage(to, { text }, token);
  const at = Date.now();
  await recordOutbound(target, text, at);
  return { ok: true, mode: 'direct', conversationId: target.conversationId, to, at };
}

// Review: post the draft into the internal review group; never touch the client.
async function draftForReview(target: ConversationSummary, text: string, reviewId: string, tenantId?: string): Promise<ReplyOutcome> {
  const review = await getConversation(reviewId, tenantId);
  if (!review) return { ok: false, reason: 'review_not_found' };
  if (review.platform !== 'line') return { ok: false, reason: 'review_not_line' };
  const token = channelToken(review.channelId);
  if (!token) return { ok: false, reason: 'review_no_token' };

  const to = review.externalConversationId;
  const draft = formatDraft(target, text);
  await pushLineMessage(to, { text: draft }, token);
  const at = Date.now();
  await recordOutbound(review, draft, at);
  return { ok: true, mode: 'review', conversationId: target.conversationId, reviewConversationId: review.conversationId, to, at };
}

function formatDraft(target: ConversationSummary, text: string): string {
  const label = target.title || target.externalConversationId;
  return [
    '📝 Draft reply — needs approval',
    `For: ${label}`,
    `(${target.conversationId})`,
    '',
    text,
    '',
    '— Reply here to revise. Once approved, post it in that client group to send.',
  ].join('\n');
}

// Record an outbound message so the transcript (client or review group) stays
// coherent. Best-effort: a failed capture must not make the tool report a send
// failure when the message actually went out.
async function recordOutbound(conversation: ConversationSummary, text: string, at: number): Promise<void> {
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
      // happy, marks this as a PM reply rather than fetchable media, and is what
      // the monthly cap counts.
      externalMessageId: `${REPLY_PUSH_PREFIX}${at}:${Math.random().toString(36).slice(2, 8)}`,
      at,
    });
  } catch (error) {
    console.error('[connector-reply] sent but failed to record outbound reply:', error);
  }
}

function channelToken(channelId: string): string | undefined {
  try {
    return getTenantChannelConfig(channelId).line?.channelAccessToken || undefined;
  } catch {
    return undefined;
  }
}
