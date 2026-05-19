import 'dotenv/config';

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const webhookUrl = process.env.LINE_WEBHOOK_URL;
if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN is required');
if (!webhookUrl) throw new Error('LINE_WEBHOOK_URL is required');

await callLine('https://api.line.me/v2/bot/channel/webhook/endpoint', { endpoint: webhookUrl });
const info = await getLine('https://api.line.me/v2/bot/channel/webhook/endpoint');
console.log('LINE webhook configured.');
console.log(JSON.stringify({ info }, null, 2));

async function callLine(url, payload) {
  const response = await fetch(url, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`LINE webhook update failed: ${response.status} ${await response.text()}`);
}

async function getLine(url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  if (!response.ok) throw new Error(`LINE webhook info failed: ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}
