// WhatsApp ingest for the Claude connector.
//
// WhatsApp is capture-only: inbound client messages (and, when the
// `message_echoes` field is subscribed, replies the operator sends from the
// WhatsApp app) are written to the same conversation log as LINE. No bot
// replies on WhatsApp, so there is no reply path here.

import { isCaptureEnabled, recordMessage } from '../../core/conversationStore.js';
import { resolveWhatsappChannel } from '../../core/tenantStore.js';
import type { WhatsappChangeValue, WhatsappMessage, WhatsappWebhookPayload } from './types.js';

export type { WhatsappWebhookPayload };

export async function handleWhatsappWebhook(payload: WhatsappWebhookPayload, channelId?: string) {
  if (!isCaptureEnabled()) return 0;
  let captured = 0;
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      const runtime = resolveWhatsappChannel({ channelId, phoneNumberId: value.metadata?.phone_number_id });
      if (!runtime) {
        console.error('[whatsapp-ingest] No channel configured for phone_number_id:', value.metadata?.phone_number_id);
        continue;
      }
      for (const message of value.messages ?? []) captured += await capture(message, value, runtime, 'inbound');
      for (const message of value.message_echoes ?? []) captured += await capture(message, value, runtime, 'outbound');
    }
  }
  return captured;
}

type WhatsappRuntime = NonNullable<ReturnType<typeof resolveWhatsappChannel>>;

async function capture(message: WhatsappMessage, value: WhatsappChangeValue, runtime: WhatsappRuntime, direction: 'inbound' | 'outbound') {
  // The conversation is always keyed by the *client's* number, so an echo of the
  // operator's own reply lands in the same thread as what the client wrote.
  const clientId = direction === 'inbound' ? message.from : message.to;
  if (!clientId) return 0;
  const described = describeMessage(message);
  if (!described) return 0;
  const contact = value.contacts?.find((item) => item.wa_id === clientId) ?? value.contacts?.[0];
  try {
    await recordMessage({
      tenantId: runtime.tenant.id,
      channelId: runtime.channel.id,
      platform: 'whatsapp',
      conversationType: 'direct',
      externalConversationId: clientId,
      title: contact?.profile?.name?.trim() || clientId,
      direction,
      senderId: direction === 'inbound' ? clientId : runtime.channel.whatsapp?.displayPhoneNumber,
      senderName: direction === 'inbound' ? contact?.profile?.name?.trim() : runtime.tenant.name,
      text: described.text,
      messageType: described.messageType,
      externalMessageId: message.id,
      at: parseTimestamp(message.timestamp),
    });
    return 1;
  } catch (error) {
    console.error('[whatsapp-ingest] Failed to capture message:', error);
    return 0;
  }
}

function describeMessage(message: WhatsappMessage): { text: string; messageType: string } | undefined {
  const type = message.type ?? 'text';
  switch (type) {
    case 'text':
      return textOr(message.text?.body, 'text');
    case 'image':
      return { text: withCaption('[image]', message.image?.caption), messageType: 'image' };
    case 'video':
      return { text: withCaption('[video]', message.video?.caption), messageType: 'video' };
    case 'audio':
      return { text: message.audio?.voice ? '[voice message]' : '[audio]', messageType: 'audio' };
    case 'document':
      return { text: withCaption(`[document: ${message.document?.filename ?? 'unnamed'}]`, message.document?.caption), messageType: 'document' };
    case 'sticker':
      return { text: '[sticker]', messageType: 'sticker' };
    case 'location': {
      const label = [message.location?.name, message.location?.address].filter(Boolean).join(', ');
      return { text: label ? `[location: ${label}]` : '[location]', messageType: 'location' };
    }
    case 'reaction':
      return message.reaction?.emoji ? { text: `[reacted ${message.reaction.emoji}]`, messageType: 'reaction' } : undefined;
    case 'button':
      return textOr(message.button?.text ?? message.button?.payload, 'button');
    case 'interactive':
      return textOr(message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title, 'interactive');
    case 'contacts':
      return { text: '[contact card]', messageType: 'contacts' };
    case 'unsupported':
      return { text: '[unsupported message]', messageType: 'unsupported' };
    default:
      return { text: `[${type}]`, messageType: type };
  }
}

function textOr(value: string | undefined, messageType: string) {
  const text = value?.trim();
  return text ? { text, messageType } : undefined;
}

function withCaption(placeholder: string, caption?: string) {
  const trimmed = caption?.trim();
  return trimmed ? `${placeholder} ${trimmed}` : placeholder;
}

function parseTimestamp(timestamp?: string) {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(seconds * 1000);
}
