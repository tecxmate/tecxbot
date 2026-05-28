import { getTenantConfig } from '../../core/tenantStore.js';
import { handleOpsTaggedMessage } from '../../ops/companyOps.js';
import { sendFacebookMessage } from './client.js';
import type { FacebookMessagingEvent, FacebookWebhookPayload } from './types.js';

export type { FacebookWebhookPayload };

export async function handleFacebookWebhook(payload: FacebookWebhookPayload) {
  let processed = 0;
  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const didProcess = await handleFacebookMessagingEvent(event, entry.id);
      if (didProcess) processed += 1;
    }
  }
  return processed;
}

async function handleFacebookMessagingEvent(event: FacebookMessagingEvent, pageId?: string) {
  if (event.message?.is_echo) return false;
  const text = event.message?.text ?? event.postback?.payload;
  const senderId = event.sender?.id;
  if (!text || !senderId) return false;

  const tenant = getTenantConfig(process.env.DEFAULT_TENANT_ID);
  const result = await handleOpsTaggedMessage({
    platform: 'facebook',
    conversationId: pageId && senderId ? `${pageId}:${senderId}` : senderId,
    senderId,
    text,
    timestamp: event.timestamp,
  }, tenant);

  if (!result.handled) return false;
  await sendFacebookMessage(senderId, result.reply);
  return true;
}
