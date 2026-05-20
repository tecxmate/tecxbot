import type { BotReply, ReplyButton } from '../../core/types.js';
import type { LineTextReply } from './types.js';

export async function replyLineMessage(replyToken: string, reply: BotReply, accessToken?: string) {
  const token = accessToken ?? process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN not configured');
  const message: LineTextReply = { type: 'text', text: reply.text.length > 3800 ? `${reply.text.slice(0, 3790)}...` : reply.text, quickReply: toLineQuickReply(reply.buttons ?? mainMenuButtons()) };
  const response = await fetch('https://api.line.me/v2/bot/message/reply', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ replyToken, messages: [message] }) });
  if (!response.ok) throw new Error(`LINE reply failed: ${response.status} ${await response.text()}`);
}

export async function pushLineMessage(to: string, reply: BotReply, accessToken?: string) {
  const token = accessToken ?? process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN not configured');
  const message: LineTextReply = { type: 'text', text: reply.text.length > 3800 ? `${reply.text.slice(0, 3790)}...` : reply.text, quickReply: toLineQuickReply(reply.buttons ?? []) };
  const response = await fetch('https://api.line.me/v2/bot/message/push', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ to, messages: [message] }) });
  if (!response.ok) throw new Error(`LINE push failed: ${response.status} ${await response.text()}`);
}

export async function downloadLineMessageContent(messageId: string, accessToken?: string) {
  const token = accessToken ?? process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN not configured');
  const response = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`LINE content download failed: ${response.status} ${await response.text()}`);
  return { content: await response.arrayBuffer(), contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
}

export function mainMenuButtons(): ReplyButton[][] {
  return [[{ label: 'Help', data: 'menu:help' }, { label: 'Settings', data: 'menu:settings' }], [{ label: 'Status', text: '/status' }, { label: 'Languages', text: '/languages' }]];
}

function toLineQuickReply(buttons: ReplyButton[][]) {
  const items = buttons.flat().slice(0, 13).map((button) => ({ type: 'action' as const, action: button.url ? { type: 'uri' as const, label: button.label.slice(0, 20), uri: button.url } : button.text ? { type: 'message' as const, label: button.label.slice(0, 20), text: button.text.slice(0, 300) } : { type: 'postback' as const, label: button.label.slice(0, 20), data: (button.data ?? button.label).slice(0, 300) } }));
  return items.length ? { items } : undefined;
}
