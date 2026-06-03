const token = process.env.TELEGRAM_BOT_TOKEN;
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!webhookUrl) throw new Error('TELEGRAM_WEBHOOK_URL is required');

const body = { url: webhookUrl, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true };
if (secret) body.secret_token = secret;

const setRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const setText = await setRes.text();
if (!setRes.ok) throw new Error(`setWebhook failed: ${setRes.status} ${setText}`);
console.log('Telegram webhook set:', setText);

const infoRes = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
console.log('Webhook info:', await infoRes.text());
