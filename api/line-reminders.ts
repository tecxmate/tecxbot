import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildWatchlistBrief } from '../src/botSystems/mcpBrief.js';
import { getDueBriefReminders, markBriefReminderSent } from '../src/core/personalProfileStore.js';
import { resolveTenantChannel } from '../src/core/tenantStore.js';
import { pushLineMessage } from '../src/platforms/line/client.js';

export const config = { maxDuration: 300 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const due = getDueBriefReminders({
    tenantId: firstQueryValue(req.query.tenant),
    channelId: firstQueryValue(req.query.channel),
    now: new Date(),
  });
  const results: Array<{ userId: string; reminderId: string; ok: boolean; error?: string }> = [];

  for (const item of due) {
    try {
      const runtime = resolveTenantChannel({ tenantId: item.profile.tenantId, channelId: item.profile.channelId });
      const config = runtime.channel.botSystem.kind === 'mcp_agent' ? runtime.channel.botSystem : undefined;
      if (!config) throw new Error('Channel is not configured as mcp_agent');
      const text = await buildWatchlistBrief({ config, profile: item.profile, template: item.reminder.template });
      await pushLineMessage(item.profile.userId, { text }, runtime.channel.line?.channelAccessToken);
      markBriefReminderSent({
        tenantId: item.profile.tenantId,
        channelId: item.profile.channelId,
        platform: 'line',
        userId: item.profile.userId,
        reminderId: item.reminder.id,
        localDate: item.localDate,
      });
      results.push({ userId: item.profile.userId, reminderId: item.reminder.id, ok: true });
    } catch (error) {
      console.error('[line-reminders] Failed:', error);
      results.push({ userId: item.profile.userId, reminderId: item.reminder.id, ok: false, error: formatError(error) });
    }
  }

  return res.status(200).json({ ok: true, due: due.length, results });
}

function isAuthorized(req: VercelRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== 'production';
  const auth = req.headers.authorization;
  const querySecret = firstQueryValue(req.query.secret);
  return auth === `Bearer ${secret}` || querySecret === secret;
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
