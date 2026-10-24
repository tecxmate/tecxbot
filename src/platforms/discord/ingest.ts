// Turn forwarded Discord messages into captured conversation rows.
//
// Discord only delivers message events over a Gateway WebSocket, which a
// serverless deployment cannot hold open. So the persistent half lives in
// scripts/discord-gateway.mjs and POSTs here; this module is the part that
// decides what is worth keeping and what a row looks like. Keeping the decision
// server-side means a listener running on someone's laptop cannot invent a
// shape the store has never seen.

import { recordMessage } from '../../core/conversationStore.js';
import { resolveDiscordChannel } from '../../core/tenantStore.js';
import type { DiscordIngestPayload, DiscordMessage } from './types.js';

/** DEFAULT and REPLY. Everything else is a join, a pin, or a system notice. */
const CAPTURED_TYPES = new Set([0, 19]);

export type IngestResult = { captured: number; skipped: number };

/**
 * Who counts as "us" in the transcript.
 *
 * Discord has no inbound/outbound distinction — a listener sees one flat
 * stream — but the project memory reads as a conversation, so the operator's
 * own messages have to be marked. Without this every message looks like the
 * client talking, and the weekly update draft gets the attribution backwards.
 */
function operatorUserIds(): Set<string> {
  return new Set(
    (process.env.DISCORD_OPERATOR_USER_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/** What a message is worth storing as, or undefined to skip it. */
export function renderDiscordMessage(message: DiscordMessage): string | undefined {
  if (message.type !== undefined && !CAPTURED_TYPES.has(message.type)) return undefined;
  // Other people's bots (CI, polls, music) would bury the human conversation
  // the memory exists to hold.
  if (message.author?.bot) return undefined;

  const text = (message.content ?? '').trim();
  const attachments = message.attachments ?? [];
  if (text) {
    if (!attachments.length) return text;
    return `${text}\n${attachments.map(describeAttachment).join('\n')}`;
  }
  if (attachments.length) return attachments.map(describeAttachment).join('\n');
  return undefined; // an embed-only or sticker-only message carries no text to keep
}

function describeAttachment(attachment: { filename?: string; content_type?: string }): string {
  const type = attachment.content_type ?? '';
  if (type.startsWith('image/')) return '[image]';
  if (type.startsWith('video/')) return '[video]';
  if (type.startsWith('audio/')) return '[audio]';
  return `[file: ${attachment.filename ?? 'attachment'}]`;
}

export function discordSenderName(message: DiscordMessage): string {
  return message.author?.global_name || message.author?.username || message.author?.id || 'unknown';
}

export async function ingestDiscordMessages(payload: DiscordIngestPayload): Promise<IngestResult> {
  const resolved = resolveDiscordChannel();
  if (!resolved) return { captured: 0, skipped: payload.messages?.length ?? 0 };

  const operators = operatorUserIds();
  let captured = 0;
  let skipped = 0;

  for (const message of payload.messages ?? []) {
    const text = renderDiscordMessage(message);
    if (!text || !message.channel_id || !message.id) {
      skipped += 1;
      continue;
    }
    await recordMessage({
      tenantId: resolved.tenant.id,
      channelId: resolved.channel.id,
      platform: 'discord',
      // A guild channel is a group; a DM has no guild.
      conversationType: message.guild_id ? 'group' : 'direct',
      externalConversationId: message.channel_id,
      title: conversationTitle(payload, message),
      direction: operators.has(message.author?.id ?? '') ? 'outbound' : 'inbound',
      senderId: message.author?.id,
      senderName: discordSenderName(message),
      text,
      messageType: 'text',
      // Discord snowflakes are unique per message, so a replayed backfill
      // overwrites rather than duplicating.
      externalMessageId: message.id,
      at: message.timestamp ? Date.parse(message.timestamp) || undefined : undefined,
    });
    captured += 1;
  }

  return { captured, skipped };
}

function conversationTitle(payload: DiscordIngestPayload, message: DiscordMessage): string | undefined {
  const channel = payload.channelName?.trim();
  const guild = payload.guildName?.trim();
  if (channel && guild) return `${guild} — #${channel}`;
  if (channel) return `#${channel}`;
  if (guild) return guild;
  return message.guild_id ? undefined : 'Discord DM';
}
