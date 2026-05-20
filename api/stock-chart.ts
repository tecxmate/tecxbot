import type { VercelRequest, VercelResponse } from '@vercel/node';
import { callMcpTool } from '../src/core/mcpClient.js';
import { renderPriceLinePng } from '../src/core/pngChart.js';
import { resolveTenantChannel } from '../src/core/tenantStore.js';

export const config = { maxDuration: 60 };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const ticker = firstQueryValue(req.query.ticker)?.trim().toUpperCase();
  if (!ticker || !/^[0-9A-Z]+[A-Z]?$/.test(ticker)) return res.status(400).json({ error: 'Invalid ticker' });
  const days = parseDays(firstQueryValue(req.query.days));
  const runtime = resolveTenantChannel({
    tenantId: firstQueryValue(req.query.tenant),
    channelId: firstQueryValue(req.query.channel),
  });
  const botSystem = runtime.channel.botSystem;
  if (botSystem.kind !== 'mcp_agent') return res.status(400).json({ error: 'Channel is not configured for MCP agent' });

  try {
    const result = await callMcpTool(botSystem, 'price_history', { ticker_id: ticker, days });
    const prices = extractPrices(result.result);
    const png = renderPriceLinePng({
      points: prices,
      title: `${ticker} CLOSE PRICE`,
      subtitle: `${days} TRADING DAYS`,
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('CDN-Cache-Control', 'public, max-age=3600');
    res.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).send(Buffer.from(png));
  } catch (error) {
    console.error('[stock-chart] Failed:', error);
    return res.status(500).json({ error: formatError(error) });
  }
}

function extractPrices(result: unknown) {
  if (!isRecord(result)) return [];
  const prices = result.prices;
  return Array.isArray(prices) ? prices.filter(isRecord) : [];
}

function parseDays(value: string | undefined) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 90;
  return Math.max(5, Math.min(365, Math.round(parsed)));
}

function firstQueryValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
