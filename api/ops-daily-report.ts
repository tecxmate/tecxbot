import type { VercelRequest, VercelResponse } from '@vercel/node';
import { buildDailyOpsReport } from '../src/ops/companyOps.js';
import { getOpsConfig } from '../src/ops/config.js';
import { sendFacebookUpdate } from '../src/platforms/facebook/client.js';

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && firstQueryValue(req.query.secret) !== cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const report = await buildDailyOpsReport();
    const config = getOpsConfig();
    const shouldSend = firstQueryValue(req.query.send) === 'true' || process.env.OPS_DAILY_REPORT_SEND === 'true';
    if (shouldSend && config.messengerSummaryRecipientId) {
      await sendFacebookUpdate(config.messengerSummaryRecipientId, report.text);
    }
    return res.status(200).json({
      ok: true,
      sent: Boolean(shouldSend && config.messengerSummaryRecipientId),
      linearIssueCount: report.linearIssues.length,
      githubIssueCount: report.githubIssues.length,
      googleTaskCount: report.googleTasks.length,
      report: report.text,
    });
  } catch (error) {
    console.error('[ops-daily-report] Failed:', error);
    return res.status(500).json({ ok: false, error: formatError(error) });
  }
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
