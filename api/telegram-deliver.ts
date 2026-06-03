import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyChatToken } from '../src/core/telegramLink.js';
import { sendTelegramMessage } from '../src/platforms/telegram/client.js';

// The web upload page POSTs the finished transcript here with the signed token
// from its URL. We verify the token and push the text to that Telegram chat.

export const config = { maxDuration: 30 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, text } = (req.body || {}) as { token?: string; text?: string };
  if (!token || typeof text !== 'string') return res.status(400).json({ error: 'Missing token or text' });

  const chatId = verifyChatToken(token);
  if (!chatId) return res.status(401).json({ error: 'Invalid or expired link' });

  const transcript = text.trim();
  if (!transcript) return res.status(400).json({ error: 'Empty transcript' });

  try {
    for (let index = 0; index < transcript.length; index += 3900) {
      await sendTelegramMessage(chatId, transcript.slice(index, index + 3900));
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Delivery failed';
    console.error('[telegram-deliver]', message);
    return res.status(500).json({ error: message });
  }
}
