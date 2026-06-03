import type { TelegramInlineButton } from './types.js';

const API = 'https://api.telegram.org';

function botToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured');
  return token;
}

export async function sendTelegramMessage(chatId: number | string, text: string, buttons?: TelegramInlineButton[][]) {
  const reply_markup = buttons ? { inline_keyboard: buttons } : undefined;
  const response = await fetch(`${API}/bot${botToken()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096), reply_markup }),
  });
  if (!response.ok) throw new Error(`Telegram sendMessage failed: ${response.status} ${await response.text()}`);
}

export async function answerCallbackQuery(callbackQueryId: string, text?: string) {
  await fetch(`${API}/bot${botToken()}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

export async function downloadTelegramFile(fileId: string): Promise<{ content: ArrayBuffer; contentType: string }> {
  const metaResponse = await fetch(`${API}/bot${botToken()}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!metaResponse.ok) throw new Error(`Telegram getFile failed: ${metaResponse.status} ${await metaResponse.text()}`);
  const meta = await metaResponse.json() as { ok: boolean; result?: { file_path?: string } };
  const filePath = meta.result?.file_path;
  if (!filePath) throw new Error('Telegram getFile returned no file_path (file may exceed the 20MB bot download limit)');
  const fileResponse = await fetch(`${API}/file/bot${botToken()}/${filePath}`);
  if (!fileResponse.ok) throw new Error(`Telegram file download failed: ${fileResponse.status}`);
  return { content: await fileResponse.arrayBuffer(), contentType: fileResponse.headers.get('content-type') ?? 'application/octet-stream' };
}
