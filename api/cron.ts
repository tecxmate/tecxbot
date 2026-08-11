// Scheduled jobs — one function, dispatched by `?job=`.
//
//   GET /api/cron?job=line-reminders&secret=<CRON_SECRET>
//   GET /api/cron?job=ops-daily-report&secret=<CRON_SECRET>
//
// The historical `/api/line-reminders` and `/api/ops-daily-report` URLs are
// rewritten here by vercel.json, so an existing Vercel Cron entry, GitHub
// Action, or external scheduler keeps working unchanged.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildWatchlistBrief } from '../src/botSystems/mcpBrief.js';
import { buildDailyOpsReport } from '../src/ops/companyOps.js';
import { getOpsConfig } from '../src/ops/config.js';
import { getDueBriefReminders, markBriefReminderSent } from '../src/core/personalProfileStore.js';
import { resolveTenantChannel } from '../src/core/tenantStore.js';
import { sendFacebookUpdate } from '../src/platforms/facebook/client.js';
import { pushLineMessage } from '../src/platforms/line/client.js';

// The reminder sweep is the slow one; it sets the ceiling for both jobs.
export const config = { maxDuration: 300 };

const JOBS = ['line-reminders', 'ops-daily-report'] as const;
type Job = (typeof JOBS)[number];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const job = firstQueryValue(req.query.job) as Job | undefined;
  if (!job || !JOBS.includes(job)) {
    return res.status(400).json({ error: `Unknown job: ${job ?? '(missing)'}. Expected one of: ${JOBS.join(', ')}.` });
  }

  if (job === 'line-reminders') return runLineReminders(req, res);
  return runOpsDailyReport(req, res);
}

async function runLineReminders(req: VercelRequest, res: VercelResponse) {
  const due = getDueBriefReminders({
    tenantId: firstQueryValue(req.query.tenant),
    channelId: firstQueryValue(req.query.channel),
    now: new Date(),
  });
  const results: Array<{ userId: string; reminderId: string; ok: boolean; error?: string }> = [];

  for (const item of due) {
    try {
      const runtime = resolveTenantChannel({ tenantId: item.profile.tenantId, channelId: item.profile.channelId });
      const botSystem = runtime.channel.botSystem.kind === 'mcp_agent' ? runtime.channel.botSystem : undefined;
      if (!botSystem) throw new Error('Channel is not configured as mcp_agent');
      const text = await buildWatchlistBrief({ config: botSystem, profile: item.profile, template: item.reminder.template });
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
      console.error('[cron:line-reminders] Failed:', error);
      results.push({ userId: item.profile.userId, reminderId: item.reminder.id, ok: false, error: formatError(error) });
    }
  }

  return res.status(200).json({ ok: true, job: 'line-reminders', due: due.length, results });
}

async function runOpsDailyReport(req: VercelRequest, res: VercelResponse) {
  try {
    const report = await buildDailyOpsReport();
    const opsConfig = getOpsConfig();
    const shouldSend = firstQueryValue(req.query.send) === 'true' || process.env.OPS_DAILY_REPORT_SEND === 'true';
    if (shouldSend && opsConfig.messengerSummaryRecipientId) {
      await sendFacebookUpdate(opsConfig.messengerSummaryRecipientId, report.text);
    }
    return res.status(200).json({
      ok: true,
      job: 'ops-daily-report',
      sent: Boolean(shouldSend && opsConfig.messengerSummaryRecipientId),
      linearIssueCount: report.linearIssues.length,
      githubIssueCount: report.githubIssues.length,
      googleTaskCount: report.googleTasks.length,
      report: report.text,
    });
  } catch (error) {
    console.error('[cron:ops-daily-report] Failed:', error);
    return res.status(500).json({ ok: false, job: 'ops-daily-report', error: formatError(error) });
  }
}

// With no CRON_SECRET set this stays open outside production and closes in it,
// so an unconfigured deployment cannot be triggered by anyone who finds the URL.
function isAuthorized(req: VercelRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return process.env.VERCEL_ENV !== 'production';
  return req.headers.authorization === `Bearer ${secret}` || firstQueryValue(req.query.secret) === secret;
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
