import { callMcpTool } from '../core/mcpClient.js';
import type { BotSystemConfig } from '../core/types.js';
import type { PersonalProfile, WatchlistBriefTemplate } from '../core/personalProfileStore.js';

type McpAgentConfig = Extract<BotSystemConfig, { kind: 'mcp_agent' }>;

export async function buildWatchlistBrief(input: { config: McpAgentConfig; profile: PersonalProfile; template: WatchlistBriefTemplate; maxTickers?: number }) {
  const tickers = input.profile.watchlist.slice(0, input.maxTickers ?? 5);
  if (!tickers.length) {
    return 'Watchlist brief\n\nYour watchlist is empty. Add one with /watch 2330 reason';
  }

  const sections = [briefTitle(input.template)];
  for (const item of tickers) {
    sections.push(await buildTickerBrief({ config: input.config, ticker: item.ticker, label: [item.ticker, item.companyName].filter(Boolean).join(' '), template: input.template }));
  }
  sections.push(profileFooter(input.profile));
  return sections.filter(Boolean).join('\n\n').slice(0, 3800);
}

function briefTitle(template: WatchlistBriefTemplate) {
  if (template === 'premarket') return 'Premarket watchlist brief';
  if (template === 'midday') return 'Midday watchlist brief';
  if (template === 'postclose') return 'Post-close watchlist brief';
  if (template === 'risk') return 'Risk watchlist brief';
  if (template === 'news') return 'News watchlist brief';
  return 'Flow watchlist brief';
}

async function buildTickerBrief(input: { config: McpAgentConfig; ticker: string; label: string; template: WatchlistBriefTemplate }) {
  const calls: Array<Promise<{ name: string; result: unknown }>> = [];
  if (input.template === 'news') {
    calls.push(safeTool(input.config, 'n_for_ticker', { ticker_id: input.ticker, days: 3, limit: 3 }));
  } else if (input.template === 'flow') {
    calls.push(safeTool(input.config, 'sc_ticker_momentum', { ticker_id: input.ticker, window: '5d', top_n: 1 }));
  } else if (input.template === 'risk') {
    calls.push(safeTool(input.config, 'q_indicators', { ticker_id: input.ticker }));
    calls.push(safeTool(input.config, 'q_valuation', { ticker_id: input.ticker }));
  } else {
    calls.push(safeTool(input.config, 'q_indicators', { ticker_id: input.ticker }));
    calls.push(safeTool(input.config, 'sc_ticker_momentum', { ticker_id: input.ticker, window: '5d', top_n: 1 }));
    calls.push(safeTool(input.config, 'n_for_ticker', { ticker_id: input.ticker, days: 2, limit: 2 }));
  }
  const results = await Promise.all(calls);
  return [`${input.label}`, ...results.map(formatToolSnippet)].filter(Boolean).join('\n');
}

async function safeTool(config: McpAgentConfig, name: string, args: Record<string, unknown>) {
  try {
    const call = await callMcpTool(config, name, args);
    return { name, result: call.result };
  } catch (error) {
    return { name, result: { error: error instanceof Error ? error.message : String(error) } };
  }
}

function formatToolSnippet(call: { name: string; result: unknown }) {
  const record = asRecord(call.result);
  if (record?.error) return `${call.name}: ${String(record.error).slice(0, 180)}`;
  if (call.name === 'q_indicators') return formatIndicators(call.result);
  if (call.name === 'sc_ticker_momentum') return formatFlow(call.result);
  if (call.name === 'n_for_ticker') return formatNews(call.result);
  if (call.name === 'q_valuation') return formatValuation(call.result);
  return compactJson(call.result).slice(0, 260);
}

function formatIndicators(result: unknown) {
  const row = asRecord(result) ?? firstRow(result, ['signals', 'rows']);
  if (!row) return undefined;
  return `Indicators: RSI ${fmt(row.rsi_14)} | MACD hist ${fmt(row.macd_histogram)} | foreign z20 ${fmt(row.foreign_net_z20)} | RS 60d ${fmt(row.rs_vs_market_60)}`;
}

function formatFlow(result: unknown) {
  const row = firstRow(result, ['tickers', 'rows']);
  if (!row) return 'Flow: no row';
  return `Flow: foreign 5d ${fmt(row.foreign_5d)} | 10d ${fmt(row.foreign_10d)} | streak ${fmt(row.foreign_buy_streak ?? row.buy_streak)}`;
}

function formatNews(result: unknown) {
  const rows = rowsFrom(result, ['articles', 'rows']).slice(0, 2);
  if (!rows.length) return 'News: no recent match';
  return `News: ${rows.map((row) => String(row.title ?? row.summary ?? '').slice(0, 90)).filter(Boolean).join(' / ')}`;
}

function formatValuation(result: unknown) {
  const row = firstRow(result, ['valuations', 'rows']);
  if (!row) return 'Valuation: no row';
  return `Valuation: PE ${fmt(row.pe_ratio ?? row.pe)} | PB ${fmt(row.pb_ratio ?? row.pb)} | yield ${fmt(row.dividend_yield)}`;
}

function profileFooter(profile: PersonalProfile) {
  return `Profile: ${profile.tone} tone | ${profile.risk} risk setting | ${profile.language} language`;
}

function rowsFrom(result: unknown, keys: string[]) {
  const record = asRecord(result);
  for (const key of keys) {
    const value = record?.[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return Array.isArray(result) ? result.filter(isRecord) : [];
}

function firstRow(result: unknown, keys: string[]) {
  return rowsFrom(result, keys)[0];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fmt(value: unknown) {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return '-';
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
