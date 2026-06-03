import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleTelegramUpdate } from '../src/platforms/telegram/webhook.js';
import type { TelegramUpdate } from '../src/platforms/telegram/types.js';

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return res.status(401).json({ error: 'Invalid secret token' });
  }

  try {
    await handleTelegramUpdate(req.body as TelegramUpdate);
    return res.status(200).json({ ok: true });
  } catch (error) {
    // Always 200 so Telegram does not retry-storm on a transient failure.
    console.error('[telegram-webhook] Failed:', error);
    return res.status(200).json({ ok: false });
  }
}
