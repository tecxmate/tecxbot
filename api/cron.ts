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
import { pruneOlderThan, storeBackend } from '../src/core/conversationStore.js';
import { archivePendingMedia } from '../src/connector/media.js';
import { isR2Configured } from '../src/core/r2.js';
import { getDueBriefReminders, markBriefReminderSent } from '../src/core/personalProfileStore.js';
import { resolveTenantChannel } from '../src/core/tenantStore.js';
import { sendFacebookUpdate } from '../src/platforms/facebook/client.js';
import { pushLineMessage } from '../src/platforms/line/client.js';

// The reminder sweep is the slow one; it sets the ceiling for all jobs.
export const config = { maxDuration: 300 };

const JOBS = ['line-reminders', 'ops-daily-report', 'connector-prune', 'archive-media'] as const;
type Job = (typeof JOBS)[number];

const DEFAULT_RETENTION_DAYS = 90;
const MS_PER_DAY = 86_400_000;
// Media is only archived while LINE still holds it; look back a couple of days
// so a lagging schedule still catches recent media.
const ARCHIVE_WINDOW_MS = 2 * MS_PER_DAY;
const ARCHIVE_MAX_BYTES = 25 * 1024 * 1024;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const job = firstQueryValue(req.query.job) as Job | undefined;
  if (!job || !JOBS.includes(job)) {
    return res.status(400).json({ error: `Unknown job: ${job ?? '(missing)'}. Expected one of: ${JOBS.join(', ')}.` });
  }

  if (job === 'line-reminders') return runLineReminders(req, res);
  if (job === 'connector-prune') return runConnectorPrune(req, res);
  if (job === 'archive-media') return runArchiveMedia(req, res);
  return runOpsDailyReport(req, res);
}

async function runArchiveMedia(req: VercelRequest, res: VercelResponse) {
  if (!isR2Configured()) {
    return res.status(200).json({ ok: true, job: 'archive-media', skipped: 'R2 not configured (set R2_ACCOUNT_ID/R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)' });
  }
  if (storeBackend() !== 'postgres') {
    return res.status(200).json({ ok: true, job: 'archive-media', skipped: 'in-memory store: nothing durable to archive against' });
  }
  const limit = Math.min(100, Math.max(1, Number(firstQueryValue(req.query.limit)) || 25));
  try {
    const result = await archivePendingMedia({ sinceMs: Date.now() - ARCHIVE_WINDOW_MS, limit, maxBytes: ARCHIVE_MAX_BYTES });
    return res.status(200).json({ ok: true, job: 'archive-media', ...result });
  } catch (error) {
    console.error('[cron:archive-media] Failed:', error);
    return res.status(500).json({ ok: false, job: 'archive-media', error: formatError(error) });
  }
}

async function runConnectorPrune(req: VercelRequest, res: VercelResponse) {
  // `?days=` overrides CONNECTOR_RETENTION_DAYS for a one-off sweep; 0 disables.
  const days = resolveRetentionDays(firstQueryValue(req.query.days));
  if (days <= 0) {
    return res.status(200).json({ ok: true, job: 'connector-prune', skipped: 'retention disabled (set CONNECTOR_RETENTION_DAYS or ?days=)' });
  }
  if (storeBackend() !== 'postgres') {
    // The in-memory store is per-instance and already self-evicts, so there is
    // nothing durable to prune — say so rather than silently no-op.
    return res.status(200).json({ ok: true, job: 'connector-prune', skipped: 'in-memory store: nothing durable to prune', retentionDays: days });
  }
  try {
    const cutoff = Date.now() - days * MS_PER_DAY;
    const result = await pruneOlderThan(cutoff);
    return res.status(200).json({ ok: true, job: 'connector-prune', retentionDays: days, cutoff, ...result });
  } catch (error) {
    console.error('[cron:connector-prune] Failed:', error);
    return res.status(500).json({ ok: false, job: 'connector-prune', error: formatError(error) });
  }
}

function resolveRetentionDays(override: string | undefined): number {
  const raw = override ?? process.env.CONNECTOR_RETENTION_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(parsed);
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
