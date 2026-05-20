import { callMcpTool, type McpToolCallResult } from '../core/mcpClient.js';
import { addPersonalWatchItem, getPersonalProfile, removeBriefReminder, removePersonalWatchItem, setBriefReminderEnabled, setPersonalPreferences, upsertBriefReminder, type PersonalLanguage, type PersonalProfile, type PersonalRisk, type PersonalTone, type WatchlistBriefTemplate } from '../core/personalProfileStore.js';
import type { BotReply, TenantConfig } from '../core/types.js';
import type { LineEvent, LineSource } from '../platforms/line/types.js';
import type { LineWebhookRuntime } from '../platforms/line/webhook.js';
import { buildWatchlistBrief } from './mcpBrief.js';

type McpAgentCommandName =
  | 'help'
  | 'helpReports'
  | 'helpWatchlist'
  | 'helpSettings'
  | 'helpAdvanced'
  | 'status'
  | 'whoami'
  | 'q'
  | 'chart'
  | 'flow'
  | 'map'
  | 'n'
  | 'recent'
  | 'screen'
  | 'regime'
  | 'quality'
  | 'valuation'
  | 'digest'
  | 'watchlist'
  | 'watch'
  | 'unwatch'
  | 'backtest'
  | 'alpha'
  | 'factor'
  | 'leadlag'
  | 'profile'
  | 'pref'
  | 'reminder'
  | 'brief';

type McpAgentCommand = { name: McpAgentCommandName; args: string[] };
type SuggestedAction = { label: string; command: string };

const writeTools = new Set(['w_add', 'w_remove']);
const validWindows = new Set(['1d', '3d', '5d', '10d', '20d']);
const validPillars = new Set(['semiconductor', 'equipment', 'infrastructure', 'energy']);
const tickerAliases = new Map<string, string>([
  ['tsmc', '2330'],
  ['台積電', '2330'],
  ['台積', '2330'],
  ['鴻海', '2317'],
  ['foxconn', '2317'],
  ['hon hai', '2317'],
  ['廣達', '2382'],
  ['quanta', '2382'],
  ['緯創', '3231'],
  ['wistron', '3231'],
  ['技嘉', '2376'],
  ['gigabyte', '2376'],
  ['緯穎', '6669'],
  ['wiwynn', '6669'],
  ['世芯', '3661'],
  ['alchip', '3661'],
  ['創意', '3443'],
  ['guc', '3443'],
  ['川湖', '2059'],
  ['king slide', '2059'],
  ['奇鋐', '3017'],
  ['avc', '3017'],
  ['雙鴻', '3324'],
  ['auras', '3324'],
  ['健策', '3653'],
  ['jentech', '3653'],
  ['台達電', '2308'],
  ['delta', '2308'],
  ['光寶科', '2301'],
  ['lite-on', '2301'],
  ['liteon', '2301'],
  ['欣興', '3037'],
  ['unimicron', '3037'],
  ['南電', '8046'],
  ['nan ya pcb', '8046'],
]);

export async function handleMcpAgentLineEvent(event: LineEvent, runtime: LineWebhookRuntime): Promise<BotReply | undefined> {
  const source = event.source;
  if (source?.type === 'group' || source?.type === 'room') {
    if (event.type === 'join') return groupDisabledReply();
    if (event.type === 'message' && 'message' in event && event.message.type === 'text' && event.message.text.trim().startsWith('/')) return groupDisabledReply();
    return undefined;
  }
  if (event.type === 'follow' || event.type === 'join') return mcpWelcomeReply(source, runtime.tenant);
  if (event.type === 'postback' && 'postback' in event) return handleMcpPostback(event.postback?.data ?? '', source, runtime);
  if (event.type !== 'message' || !('message' in event) || event.message.type !== 'text') return undefined;

  const text = event.message.text.trim();
  const command = parseMcpAgentCommand(text);
  if (!command) {
    if (/^(help|menu|start|開始|說明)$/i.test(text)) return mcpHelpReply(source);
    return deterministicGuidanceReply(text, source);
  }
  const reply = await executeMcpAgentCommand(command, source, runtime);
  return decorateReplyForProfile(reply, source, runtime, command.name);
}

function handleMcpPostback(data: string, source: LineSource | undefined, runtime: LineWebhookRuntime) {
  const commandText = data.startsWith('mcp:') ? data.slice(4) : data;
  const command = parseMcpAgentCommand(commandText.startsWith('/') ? commandText : `/${commandText}`);
  return command ? executeMcpAgentCommand(command, source, runtime) : mcpHelpReply(source);
}

async function executeMcpAgentCommand(command: McpAgentCommand, source: LineSource | undefined, runtime: LineWebhookRuntime): Promise<BotReply> {
  const config = runtime.channel.botSystem.kind === 'mcp_agent' ? runtime.channel.botSystem : undefined;
  if (!config) return { text: 'MCP agent is not configured for this LINE channel.', buttons: buttonsFor(source) };

  try {
    if (command.name === 'help') return mcpHelpReply(source);
    if (command.name === 'helpReports') return reportHelpReply(source);
    if (command.name === 'helpWatchlist') return watchlistHelpReply(source);
    if (command.name === 'helpSettings') return settingsHelpReply(source);
    if (command.name === 'helpAdvanced') return advancedHelpReply(source);
    if (command.name === 'profile') return profileReply(source, runtime);
    if (command.name === 'pref') return updateProfilePreferences(command.args, source, runtime);
    if (command.name === 'reminder') return reminderReply(command.args, source, runtime);
    if (command.name === 'brief') return runWatchlistBrief(config, command.args, source, runtime);
    if (command.name === 'status') return runSingleTool(config, 'sc_data_status', {}, formatDataStatus, source);
    if (command.name === 'whoami') return whoamiReply(source);
    if (command.name === 'q') return runTickerSnapshot(config, command.args, source);
    if (command.name === 'chart') return runChartCommand(command.args, source, runtime);
    if (command.name === 'flow') return runFlow(config, command.args, source);
    if (command.name === 'map') return runMap(config, command.args, source);
    if (command.name === 'n') return runTickerNews(config, command.args, source);
    if (command.name === 'recent') return runRecentNews(config, command.args, source);
    if (command.name === 'screen') return runScreen(config, command.args, source);
    if (command.name === 'regime') return runSingleTool(config, 'q_regime', {}, formatRegime, source);
    if (command.name === 'quality') return runQuality(config, command.args, source);
    if (command.name === 'valuation') return runValuation(config, command.args, source);
    if (command.name === 'digest') return runDigest(config, command.args, source);
    if (command.name === 'watchlist') return personalWatchlistReply(source, runtime);
    if (command.name === 'watch') return runWatchMutation(config, command.args, source, runtime);
    if (command.name === 'unwatch') return runUnwatchMutation(config, command.args, source, runtime);
    if (command.name === 'backtest') return runBacktest(config, command.args, source);
    if (command.name === 'alpha') return runFactorAlpha(config, command.args, source);
    if (command.name === 'factor') return runFactorScreen(config, command.args, source);
    if (command.name === 'leadlag') return runLeadLag(config, command.args, source);
  } catch (error) {
    console.error('[mcp-agent] command failed:', error);
    return { text: `MCP command failed: ${formatError(error)}`, buttons: buttonsFor(source) };
  }
  return mcpHelpReply(source);
}

async function runTickerSnapshot(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined): Promise<BotReply> {
  const ticker = parseTicker(args[0]);
  if (!ticker) return usageReply('/q <ticker>\nExample: /q 2330', source);
  try {
    const card = await callMcpTool(config, 'beginner_stock_card', { ticker_id: ticker });
    return { text: formatBeginnerStockCard(card.result), buttons: tickerReportButtons(source, ticker) };
  } catch (error) {
    console.warn('[mcp-agent] beginner_stock_card failed, falling back:', error);
  }
  const calls = await runToolsSettled(config, [
    ['q_indicators', { ticker_id: ticker }],
    ['q_valuation', { ticker_id: ticker }],
    ['sc_ticker_momentum', { ticker_id: ticker, window: parseWindow(args[1]), top_n: 1 }],
  ]);
  return { text: formatTickerReport(ticker, calls), buttons: tickerReportButtons(source, ticker) };
}

async function runChartCommand(args: string[], source: LineSource | undefined, runtime: LineWebhookRuntime): Promise<BotReply> {
  const ticker = parseTicker(args[0]);
  if (!ticker) return usageReply('/chart <ticker>\nExample: /chart 2330', source);
  const days = parseLimit(args[1], 90);
  return {
    imageUrl: stockChartUrl({ ticker, days, tenantId: runtime.tenant.id, channelId: runtime.channel.id }),
    text: `Price chart ${ticker}\n\nClose-price line, ${days} trading days.\nData source: MCP price_history.`,
    buttons: tickerReportButtons(source, ticker),
  };
}

async function runFlow(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined): Promise<BotReply> {
  const first = args[0]?.toLowerCase();
  const window = parseWindow(args.find((arg) => validWindows.has(arg.toLowerCase())));
  if (first && validPillars.has(first)) {
    return runSingleTool(config, 'sc_sector_momentum', { pillar: first, window, top_n: parseLimit(args[2], 10) }, formatSectorMomentum, source);
  }
  const ticker = parseTicker(args[0]);
  return runSingleTool(config, 'sc_ticker_momentum', { ticker_id: ticker, window, top_n: ticker ? 1 : parseLimit(args[0], 10) }, formatTickerMomentum, source);
}

async function runMap(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined): Promise<BotReply> {
  const search = args.join(' ').trim();
  if (!search) return usageReply('/map <ticker or keyword>\nExample: /map 2330', source);
  return runSingleTool(config, 'sc_supply_chain_map', { search }, formatSupplyChainMap, source);
}

async function runTickerNews(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined): Promise<BotReply> {
  const ticker = parseTicker(args[0]);
  if (!ticker) return usageReply('/n <ticker> [days]\nExample: /n 2330 7', source);
  return runSingleTool(config, 'n_for_ticker', { ticker_id: ticker, days: parseLimit(args[1], 14), limit: 8 }, formatNews, source);
}

async function runRecentNews(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined): Promise<BotReply> {
  return runSingleTool(config, 'n_recent', { days: parseLimit(args[0], 1), limit: 8 }, formatNews, source);
}

async function runScreen(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined): Promise<BotReply> {
  const preset = (args[0] ?? 'foreign').toLowerCase();
  if (preset === 'extreme') return runSingleTool(config, 'u_universe', { filter: 'extreme' }, formatUniverseRows, source);
  const filters = preset === 'oversold'
    ? { rsi_below: 40, above_sma_200: true, macd_hist_above: 0 }
    : preset === 'momentum'
      ? { rsi_above: 55, macd_hist_above: 0, rs_above: 1.0 }
      : { foreign_z_above: 1.5 };
  return runSingleTool(config, 'q_screener', filters, formatUniverseRows, source);
}

async function runQuality(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined): Promise<BotReply> {
  const ticker = parseTicker(args[0]);
  const pillar = args[0]?.toLowerCase();
  const params = ticker ? { ticker_id: ticker } : validPillars.has(pillar) ? { pillar, top_n: parseLimit(args[1], 10) } : { top_n: parseLimit(args[0], 10) };
  return runSingleTool(config, 'q_quality_score', params, formatQuality, source);
}

async function runValuation(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined): Promise<BotReply> {
  const ticker = parseTicker(args[0]);
  const pillar = args[0]?.toLowerCase();
  const params = ticker ? { ticker_id: ticker } : validPillars.has(pillar) ? { pillar, top_n: parseLimit(args[1], 10) } : { top_n: parseLimit(args[0], 10) };
  return runSingleTool(config, 'q_valuation', params, formatValuation, source);
}

async function runDigest(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined): Promise<BotReply> {
  return runSingleTool(config, 'd_recent', { days: parseLimit(args[0], 3), kind: args[1] }, formatDigests, source);
}

async function runWatchlistBrief(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined, runtime: LineWebhookRuntime): Promise<BotReply> {
  const profile = getPersonalProfile(requireProfileKey(source, runtime));
  const template = parseBriefTemplate(args[0]) ?? 'premarket';
  return {
    text: await buildWatchlistBrief({ config, profile, template }),
    buttons: buttonsFor(source),
  };
}

async function runWatchMutation(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined, runtime: LineWebhookRuntime): Promise<BotReply> {
  const ticker = parseTicker(args[0]);
  if (!ticker) return usageReply('/watch <ticker> [reason]\nExample: /watch 2330 AI foundry flow improving', source);
  const reason = args.slice(1).join(' ').trim() || undefined;
  const profileKey = requireProfileKey(source, runtime);
  let meta: { companyName?: string; pillar?: string; node?: string } = {};
  try {
    const mapResult = await callMcpTool(config, 'sc_supply_chain_map', { search: ticker });
    meta = firstCompanyMeta(mapResult.result, ticker);
  } catch (error) {
    console.warn('[mcp-agent] watch metadata lookup failed:', error);
  }
  const profile = addPersonalWatchItem({ ...profileKey, ticker, reason, ...meta });
  if (process.env.MCP_AGENT_SYNC_PERSONAL_WATCH_TO_SHARED === 'true') {
    assertCanWrite(source, 'w_add');
    await callMcpTool(config, 'w_add', { ticker_id: ticker, reason });
  }
  return { text: formatPersonalWatchAdded(profile, ticker), buttons: buttonsFor(source) };
}

async function runUnwatchMutation(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined, runtime: LineWebhookRuntime): Promise<BotReply> {
  const ticker = parseTicker(args[0]);
  if (!ticker) return usageReply('/unwatch <ticker>\nExample: /unwatch 2330', source);
  const { profile, removed } = removePersonalWatchItem({ ...requireProfileKey(source, runtime), ticker });
  if (process.env.MCP_AGENT_SYNC_PERSONAL_WATCH_TO_SHARED === 'true') {
    assertCanWrite(source, 'w_remove');
    await callMcpTool(config, 'w_remove', { ticker_id: ticker });
  }
  return { text: removed ? formatPersonalWatchRemoved(profile, ticker) : `${ticker} was not in your personal watchlist.`, buttons: buttonsFor(source) };
}

async function runBacktest(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined): Promise<BotReply> {
  const [signalName, threshold, direction = 'above', forwardDays] = args;
  const numericThreshold = Number(threshold);
  if (!signalName || !Number.isFinite(numericThreshold)) return usageReply('/backtest <signal> <threshold> [above|below] [forward_days]\nExample: /backtest rsi_14 40 below 5', source);
  return runSingleTool(config, 'q_backtest', {
    signal_name: signalName,
    threshold: numericThreshold,
    direction: direction === 'below' ? 'below' : 'above',
    forward_days: parseLimit(forwardDays, 5),
  }, formatBacktest, source);
}

async function runFactorAlpha(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined): Promise<BotReply> {
  const ticker = parseTicker(args[0]);
  if (!ticker) return usageReply('/alpha <ticker> [days]\nExample: /alpha 2330 120', source);
  return runSingleTool(config, 'q_factor_alpha', { ticker_id: ticker, days: parseLimit(args[1], 120) }, formatFactorAlpha, source);
}

async function runFactorScreen(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined): Promise<BotReply> {
  const pillar = args[0]?.toLowerCase();
  const params = validPillars.has(pillar) ? { pillar, top_n: parseLimit(args[1], 10) } : { top_n: parseLimit(args[0], 10) };
  return runSingleTool(config, 'q_factor_screen', params, formatFactorScreen, source);
}

async function runLeadLag(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, args: string[], source: LineSource | undefined): Promise<BotReply> {
  const ticker = parseTicker(args[0]);
  return runSingleTool(config, 'q_lead_lag', { upstream: ticker, top_n: parseLimit(args[1], 8) }, formatLeadLag, source);
}

async function runSingleTool(
  config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>,
  toolName: string,
  args: Record<string, unknown>,
  formatter: (result: unknown, call: McpToolCallResult) => string,
  source: LineSource | undefined,
): Promise<BotReply> {
  if (writeTools.has(toolName)) assertCanWrite(source, toolName);
  const result = await callMcpTool(config, toolName, args);
  return { text: formatter(result.result, result), buttons: buttonsFor(source) };
}

async function runToolsSettled(config: Extract<TenantConfig['botSystem'], { kind: 'mcp_agent' }>, calls: Array<[string, Record<string, unknown>]>) {
  return Promise.all(calls.map(async ([toolName, args]) => {
    try {
      return { ok: true as const, call: await callMcpTool(config, toolName, args) };
    } catch (error) {
      return { ok: false as const, toolName, error };
    }
  }));
}

function formatSnapshotCall(result: { ok: true; call: McpToolCallResult } | { ok: false; toolName: string; error: unknown }) {
  if (!result.ok) return `${result.toolName}: ${formatError(result.error)}`;
  if (result.call.toolName === 'q_indicators') return formatIndicators(result.call.result, result.call);
  if (result.call.toolName === 'q_valuation') return formatValuation(result.call.result, result.call);
  if (result.call.toolName === 'sc_ticker_momentum') return formatTickerMomentum(result.call.result, result.call);
  return compactJson(result.call.result);
}

function formatBeginnerStockCard(result: unknown) {
  const card = asRecord(result);
  if (!card) return compactJson(result);
  const price = asRecord(card.price);
  const trend = asRecord(card.trend_numbers);
  const flow = asRecord(card.flow_numbers);
  const valuation = asRecord(card.valuation_numbers);
  const chart = asRecord(card.chart);
  const chartPoints = Array.isArray(chart?.points) ? chart.points.filter(isRecord) : [];
  return joinSections([
    `Stock report: ${[stringValue(card.ticker_id), stringValue(card.company_name)].filter(Boolean).join(' ')}${stringValue(card.as_of) ? `\nAs of ${stringValue(card.as_of)}` : ''}`,
    joinLines([
      'Price',
      `Close ${fmt(price?.close)} | day change ${fmtPct(price?.change_pct)}`,
      `Chart points available: ${chartPoints.length}`,
    ]),
    joinLines([
      'Trend numbers',
      `RSI ${fmt(trend?.rsi_14)} | MACD hist ${fmt(trend?.macd_histogram)} | BB%B ${fmt(trend?.bb_pct_b)}`,
      `SMA50 ${fmt(trend?.sma_50)} | SMA200 ${fmt(trend?.sma_200)} | RS 60d ${fmt(trend?.rs_vs_market_60)}`,
    ]),
    joinLines([
      'Institutional flow',
      `Foreign 1d ${fmt(flow?.foreign_1d)} | 5d ${fmt(flow?.foreign_5d)} | 20d ${fmt(flow?.foreign_20d)}`,
      `Foreign z20 ${fmt(flow?.foreign_net_z20)} | buy streak ${fmt(flow?.consecutive_foreign_buy_days)}`,
    ]),
    joinLines([
      'Valuation',
      `PE ${fmt(valuation?.pe_ratio)} | PB ${fmt(valuation?.pb_ratio)} | yield ${fmt(valuation?.dividend_yield)}`,
    ]),
    formatBeginnerLabels(card.beginner_labels),
  ]);
}

function formatBeginnerLabels(value: unknown) {
  if (!Array.isArray(value)) return beginnerNumberGuide();
  const rows = value.filter(isRecord).slice(0, 5);
  if (!rows.length) return beginnerNumberGuide();
  return joinLines([
    'Number guide',
    ...rows.map((row) => `${stringValue(row.key) ?? '-'}: ${stringValue(row.meaning) ?? '-'}`),
  ]);
}

function formatTickerReport(ticker: string, calls: Array<{ ok: true; call: McpToolCallResult } | { ok: false; toolName: string; error: unknown }>) {
  const indicators = toolResult(calls, 'q_indicators');
  const valuation = firstObject(toolResult(calls, 'q_valuation'), ['valuations', 'rows']);
  const flow = firstObject(toolResult(calls, 'sc_ticker_momentum'), ['tickers', 'rows']);
  const indicatorRow = asRecord(indicators);
  const title = [ticker, stringValue(indicatorRow?.company_name ?? indicatorRow?.name ?? valuation?.company_name ?? flow?.company_name)].filter(Boolean).join(' ');
  const asOf = stringValue(indicatorRow?.as_of ?? flow?.as_of ?? valuation?.date);
  const sections = [
    `Stock report: ${title}${asOf ? `\nAs of ${asOf}` : ''}`,
    joinLines([
      'Price and trend numbers',
      `Close ${fmt(indicatorRow?.close ?? valuation?.close)} | RSI ${fmt(indicatorRow?.rsi_14)} | MACD hist ${fmt(indicatorRow?.macd_histogram)}`,
      `BB%B ${fmt(indicatorRow?.bb_pct_b)} | RS vs market 60d ${fmt(indicatorRow?.rs_vs_market_60)} | off 52w high ${fmt(indicatorRow?.pct_below_52w_high)}%`,
    ]),
    joinLines([
      'Institutional flow',
      `Foreign 5d ${fmt(flow?.foreign_5d)} | 10d ${fmt(flow?.foreign_10d)} | 20d ${fmt(flow?.foreign_20d)}`,
      `Buy streak ${fmt(flow?.foreign_buy_streak ?? flow?.buy_streak)} | node ${fmt(flow?.node)}`,
    ]),
    joinLines([
      'Valuation',
      `PE ${fmt(valuation?.pe_ratio ?? valuation?.pe)} | PB ${fmt(valuation?.pb_ratio ?? valuation?.pb)} | yield ${fmt(valuation?.dividend_yield)} | close ${fmt(valuation?.close)}`,
    ]),
    beginnerNumberGuide(),
  ];
  const errors = calls.filter((call) => !call.ok).map((call) => `${call.toolName}: ${formatError(call.error)}`);
  if (errors.length) sections.push(joinLines(['Data gaps', ...errors]));
  return joinSections(sections);
}

function toolResult(calls: Array<{ ok: true; call: McpToolCallResult } | { ok: false; toolName: string; error: unknown }>, toolName: string) {
  return calls.find((call) => call.ok && call.call.toolName === toolName && call.call.result)?.ok
    ? (calls.find((call) => call.ok && call.call.toolName === toolName) as { ok: true; call: McpToolCallResult }).call.result
    : undefined;
}

function beginnerNumberGuide() {
  return joinLines([
    'Number guide',
    'RSI: momentum scale from 0 to 100.',
    'MACD hist: trend momentum number.',
    'BB%B: price location inside Bollinger Bands.',
    'Foreign 5d/10d/20d: foreign investor net flow windows.',
    'PE/PB/yield: valuation numbers.',
  ]);
}

function formatIndicators(result: unknown, _call: McpToolCallResult) {
  const row = firstObject(result, ['ticker', 'signal', 'signals']) ?? asRecord(result);
  if (!row) return compactJson(result);
  return joinLines([
    `Indicators ${stringValue(row.ticker_id) ?? ''} ${stringValue(row.company_name) ?? stringValue(row.name) ?? ''}`.trim(),
    metricLine(row, [['RSI', 'rsi_14'], ['MACD hist', 'macd_histogram'], ['BB%B', 'bb_pct_b']]),
    metricLine(row, [['foreign z20', 'foreign_net_z20'], ['RS 60d', 'rs_vs_market_60'], ['off 52w high', 'pct_below_52w_high']]),
    stringValue(row.interpretation),
  ]);
}

function formatValuation(result: unknown, _call: McpToolCallResult) {
  const rows = objectArray(result, ['valuations', 'rows']);
  if (!rows.length) return 'Valuation: no rows.';
  return joinLines(['Valuation', ...rows.slice(0, 5).map((row) => {
    return `${stockLabel(row)} PE ${fmt(row.pe_ratio ?? row.pe)} PB ${fmt(row.pb_ratio ?? row.pb)} yield ${fmt(row.dividend_yield)} close ${fmt(row.close)}`;
  })]);
}

function formatTickerMomentum(result: unknown, _call: McpToolCallResult) {
  const rows = objectArray(result, ['tickers', 'rows']);
  if (!rows.length) return 'Flow momentum: no rows.';
  return joinLines(['Flow momentum', ...rows.slice(0, 8).map((row) => {
    const streak = row.foreign_buy_streak ?? row.buy_streak ?? row.consecutive_foreign_buy_days;
    return `${stockLabel(row)} foreign ${fmt(row.foreign_5d ?? row.foreign_3d ?? row.foreign_1d)} streak ${fmt(streak)} node ${stringValue(row.node) ?? '-'}`;
  })]);
}

function formatSectorMomentum(result: unknown, _call: McpToolCallResult) {
  const rows = objectArray(result, ['sectors', 'rows']);
  if (!rows.length) return 'Sector momentum: no rows.';
  return joinLines(['Sector momentum', ...rows.slice(0, 10).map((row) => `${stringValue(row.ai_pillar ?? row.pillar) ?? '-'} / ${stringValue(row.node) ?? '-'} foreign ${fmt(row.foreign_5d ?? row.foreign_3d ?? row.foreign_1d)} count ${fmt(row.ticker_count ?? row.count)}`)]);
}

function formatSupplyChainMap(result: unknown, _call: McpToolCallResult) {
  const rows = objectArray(result, ['companies', 'rows']);
  if (!rows.length) return 'Supply chain map: no rows.';
  return joinLines(['Supply chain map', ...rows.slice(0, 8).map((row) => `${stockLabel(row)} ${stringValue(row.ai_pillar ?? row.pillar) ?? '-'} / ${stringValue(row.node) ?? '-'} partner ${stringValue(row.us_partner ?? row.partner) ?? '-'}`)]);
}

function formatNews(result: unknown, _call: McpToolCallResult) {
  const rows = objectArray(result, ['articles', 'rows']);
  if (!rows.length) return 'News: no recent matches.';
  return joinLines(['News', ...rows.slice(0, 8).map((row) => {
    const title = stringValue(row.title) ?? stringValue(row.summary) ?? compactJson(row);
    return `- ${title.slice(0, 150)}${row.source ? ` (${String(row.source)})` : ''}`;
  })]);
}

function formatUniverseRows(result: unknown, _call: McpToolCallResult) {
  const rows = objectArray(result, ['matches', 'rows', 'universe']);
  if (!rows.length) return 'Screen: no matches.';
  return joinLines(['Screen results', ...rows.slice(0, 10).map((row) => `${stockLabel(row)} RSI ${fmt(row.rsi_14)} foreign z20 ${fmt(row.foreign_net_z20)} RS ${fmt(row.rs_vs_market_60)} node ${stringValue(row.node) ?? '-'}`)]);
}

function formatRegime(result: unknown, _call: McpToolCallResult) {
  const row = asRecord(result);
  if (!row) return compactJson(result);
  return joinLines([
    `Regime: ${stringValue(row.regime_label) ?? '-'}`,
    `Vol: ${stringValue(row.vol_regime) ?? '-'} trend ${stringValue(row.vol_trend) ?? '-'}`,
    `Corr: ${stringValue(row.corr_regime) ?? '-'} trend ${stringValue(row.corr_trend) ?? '-'}`,
    stringValue(row.interpretation),
  ]);
}

function formatQuality(result: unknown, _call: McpToolCallResult) {
  const rows = objectArray(result, ['rows']);
  if (rows.length) return joinLines(['Quality score', ...rows.slice(0, 10).map((row) => `${stockLabel(row)} score ${fmt(row.quality_score)} growth ${fmt(row.growth)} flow ${fmt(row.flow)}`)]);
  const row = asRecord(result);
  if (!row) return compactJson(result);
  return joinLines([`Quality ${stockLabel(row)} score ${fmt(row.quality_score)}`, stringValue(row.interpretation), compactSubscores(row.subscores)]);
}

function formatDigests(result: unknown, _call: McpToolCallResult) {
  const rows = objectArray(result, ['digests', 'rows']);
  if (!rows.length) return 'Digests: no recent rows.';
  return joinLines(['Digests', ...rows.slice(0, 5).map((row) => `- ${stringValue(row.digest_date ?? row.date) ?? ''} ${stringValue(row.kind) ?? ''}: ${(stringValue(row.title) ?? stringValue(row.summary) ?? stringValue(row.content) ?? compactJson(row)).slice(0, 220)}`)]);
}

function formatWatchlist(result: unknown, _call: McpToolCallResult) {
  const rows = objectArray(result, ['watchlist', 'rows']);
  if (!rows.length) return 'Watchlist is empty.';
  return joinLines(['Watchlist', ...rows.slice(0, 15).map((row) => `- ${stockLabel(row)} ${stringValue(row.ai_pillar ?? row.pillar) ?? '-'} / ${stringValue(row.node) ?? '-'}${row.reason ? ` - ${String(row.reason).slice(0, 120)}` : ''}`)]);
}

function formatMutationResult(result: unknown, _call: McpToolCallResult) {
  const row = asRecord(result);
  if (!row) return compactJson(result);
  if (row.error) return `Watchlist update failed: ${String(row.error)}`;
  return joinLines(['Watchlist updated', compactJson(result)]);
}

function formatBacktest(result: unknown, _call: McpToolCallResult) {
  const row = asRecord(result);
  if (!row) return compactJson(result);
  if (row.error) return `Backtest failed: ${String(row.error)}`;
  return joinLines([
    'Backtest',
    `Observations: ${fmt(row.n_observations)} hit rate ${fmt(row.hit_rate ?? row.positive_rate)} avg ${fmt(row.avg_forward_return ?? row.average_return)} median ${fmt(row.median_forward_return ?? row.median_return)}`,
    stringValue(row.sample_warning),
    compactJson(row).slice(0, 900),
  ]);
}

function formatFactorAlpha(result: unknown, _call: McpToolCallResult) {
  const row = asRecord(result);
  if (!row) return compactJson(result);
  return joinLines([
    `Factor alpha ${stockLabel(row)}`,
    `alpha annualized ${fmt(row.alpha_annualized)} t-stat ${fmt(row.alpha_tstat)} significant ${fmt(row.alpha_significant)}`,
    stringValue(row.interpretation),
  ]);
}

function formatFactorScreen(result: unknown, _call: McpToolCallResult) {
  const rows = objectArray(result, ['rows']);
  if (!rows.length) return 'Factor screen: no rows.';
  return joinLines(['Factor screen', ...rows.slice(0, 10).map((row) => `${stockLabel(row)} alpha ${fmt(row.alpha_annualized)} t ${fmt(row.alpha_tstat)} beta mkt ${fmt(asRecord(row.betas)?.market)}`)]);
}

function formatLeadLag(result: unknown, _call: McpToolCallResult) {
  const rows = objectArray(result, ['pairs', 'rows']);
  if (!rows.length) return 'Lead-lag: no pairs.';
  return joinLines(['Lead-lag', ...rows.slice(0, 8).map((row) => `${stringValue(row.upstream_id) ?? '-'} -> ${stringValue(row.downstream_id) ?? '-'} lag ${fmt(row.lag_days)}d rho ${fmt(row.rho_lag)} gain ${fmt(row.gain)}`)]);
}

function formatDataStatus(result: unknown, _call: McpToolCallResult) {
  return `Data status\n${compactJson(result).slice(0, 2500)}`;
}

function parseMcpAgentCommand(text: string): McpAgentCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const [rawName = '', ...args] = trimmed.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  if (name === 'help' || name === 'menu' || name === 'start') return { name: 'help', args };
  if ((name === 'reports' || name === 'report') && args[0]?.toLowerCase() === 'help') return { name: 'helpReports', args: args.slice(1) };
  if (name === 'help' && (args[0]?.toLowerCase() === 'reports' || args[0]?.toLowerCase() === 'report')) return { name: 'helpReports', args: args.slice(1) };
  if (name === 'help' && (args[0]?.toLowerCase() === 'watchlist' || args[0]?.toLowerCase() === 'watch')) return { name: 'helpWatchlist', args: args.slice(1) };
  if (name === 'help' && (args[0]?.toLowerCase() === 'settings' || args[0]?.toLowerCase() === 'profile')) return { name: 'helpSettings', args: args.slice(1) };
  if (name === 'help' && (args[0]?.toLowerCase() === 'advanced' || args[0]?.toLowerCase() === 'quant')) return { name: 'helpAdvanced', args: args.slice(1) };
  if (name === 'status' || name === 'data') return { name: 'status', args };
  if (name === 'whoami') return { name: 'whoami', args };
  if (name === 'profile' || name === 'me') return { name: 'profile', args };
  if (name === 'pref' || name === 'prefs' || name === 'settings') return { name: 'pref', args };
  if (name === 'reminder' || name === 'reminders' || name === 'remind') return { name: 'reminder', args };
  if (name === 'brief' || name === 'watchbrief') return { name: 'brief', args };
  if (name === 'q' || name === 'ticker' || name === 'quote') return { name: 'q', args };
  if (name === 'chart' || name === 'graph') return { name: 'chart', args };
  if (name === 'flow' || name === 'momentum') return { name: 'flow', args };
  if (name === 'map') return { name: 'map', args };
  if (name === 'n' || name === 'news') return { name: 'n', args };
  if (name === 'recent') return { name: 'recent', args };
  if (name === 'screen') return { name: 'screen', args };
  if (name === 'regime') return { name: 'regime', args };
  if (name === 'quality') return { name: 'quality', args };
  if (name === 'valuation' || name === 'value') return { name: 'valuation', args };
  if (name === 'digest') return { name: 'digest', args };
  if (name === 'watchlist' || name === 'w') return { name: 'watchlist', args };
  if (name === 'watch') return { name: 'watch', args };
  if (name === 'unwatch') return { name: 'unwatch', args };
  if (name === 'backtest' || name === 'bt') return { name: 'backtest', args };
  if (name === 'alpha') return { name: 'alpha', args };
  if (name === 'factor') return { name: 'factor', args };
  if (name === 'leadlag' || name === 'lead') return { name: 'leadlag', args };
  return { name: 'help', args };
}

function mcpWelcomeReply(source: LineSource | undefined, tenant: TenantConfig): BotReply {
  return {
    text: `${tenant.name} stock bot is connected.\n\nTecxstock works in 1:1 chat only. Use /help for commands, /watchlist for your personal list, and /reminder to schedule watchlist briefs.`,
    buttons: buttonsFor(source),
  };
}

function groupDisabledReply(): BotReply {
  return {
    text: 'Tecxstock is available in 1:1 chat only.\n\nPlease add this account as a friend and use commands there, such as /q 2330, /watchlist, or /reminder.',
    buttons: [],
  };
}

function mcpHelpReply(source: LineSource | undefined): BotReply {
  return {
    text: joinLines([
      'Tecxstock',
      '1:1 Taiwan stock intelligence for your watchlist.',
      '',
      'Most used',
      '/q 2330 - stock report',
      '/chart 2330 - price chart',
      '/watch 2330 reason - add to watchlist',
      '/watchlist - your saved stocks',
      '/brief premarket - watchlist brief now',
      '/reminder add 08:30 premarket - daily brief',
      '',
      'More menus',
      '/help reports',
      '/help watchlist',
      '/help settings',
      '/help advanced',
    ]),
    buttons: helpButtons(source),
  };
}

function reportHelpReply(source: LineSource | undefined): BotReply {
  return {
    text: joinLines([
      'Reports',
      '/q 2330 - stock report with trend, flow, valuation',
      '/chart 2330 - price chart',
      '/flow 2330 5d - institutional flow',
      '/n 2330 7 - ticker news',
      '/brief premarket - watchlist report now',
      '/screen foreign - names with foreign buying',
      '/regime - market regime',
      '',
      'Also available',
      '/flow semiconductor 5d',
      '/map 2330',
      '/quality 2330',
      '/valuation 2330',
      '/recent 1',
      '/digest 3',
    ]),
    buttons: reportButtons(source),
  };
}

function watchlistHelpReply(source: LineSource | undefined): BotReply {
  return {
    text: joinLines([
      'Watchlist',
      '/watchlist - show saved stocks',
      '/watch 2330 reason - add or update',
      '/unwatch 2330 - remove',
      '/brief premarket - brief now',
      '/reminder add 08:30 premarket - schedule brief',
      '/reminder list - show reminders',
      '/reminder off <id> - pause reminder',
      '',
      'Templates: premarket, midday, postclose, risk, news, flow',
    ]),
    buttons: watchlistButtons(source),
  };
}

function settingsHelpReply(source: LineSource | undefined): BotReply {
  return {
    text: joinLines([
      'Settings',
      '/profile - current personal settings',
      '/pref tone concise - shorter replies',
      '/pref tone balanced - normal replies',
      '/pref tone technical - more numbers',
      '/pref lang tw - Traditional Chinese mode',
      '/pref lang en - English mode',
      '/pref risk conservative - conservative framing',
      '/pref risk balanced - balanced framing',
      '/pref risk aggressive - faster signal framing',
      '/whoami - show LINE user id',
    ]),
    buttons: settingsButtons(source),
  };
}

function advancedHelpReply(source: LineSource | undefined): BotReply {
  return {
    text: joinLines([
      'Advanced',
      '/backtest rsi_14 40 below 5',
      '/alpha 2330',
      '/factor semiconductor',
      '/leadlag 2330',
      '/status - data freshness',
      '',
      'These are research tools. Use /q and /brief for normal daily workflow.',
    ]),
    buttons: advancedButtons(source),
  };
}

function whoamiReply(source: LineSource | undefined): BotReply {
  if (!source?.userId) return { text: 'No LINE user id was included in this event.', buttons: buttonsFor(source) };
  return {
    text: source.type === 'user'
      ? `Your LINE user id:\n${source.userId}\n\nThis id is used for your personal watchlist and settings.`
      : 'For privacy, run /whoami in a 1:1 chat with the bot.',
    buttons: buttonsFor(source),
  };
}

function usageReply(text: string, source: LineSource | undefined): BotReply {
  return { text, buttons: buttonsFor(source) };
}

function deterministicGuidanceReply(text: string, source: LineSource | undefined): BotReply {
  const suggestions = suggestActions(text);
  return {
    text: joinLines([
      'This bot uses commands instead of open-ended chat.',
      'Choose one of the actions below, or type /help.',
      suggestions.length ? undefined : '',
      suggestions.length ? undefined : 'Common commands:',
      suggestions.length ? undefined : '/q 2330',
      suggestions.length ? undefined : '/screen foreign',
      suggestions.length ? undefined : '/regime',
    ]),
    buttons: buttonsFromSuggestions(source, suggestions.length ? suggestions : [
      { label: 'Snapshot', command: '/q 2330' },
      { label: 'Foreign screen', command: '/screen foreign' },
      { label: 'Regime', command: '/regime' },
      { label: 'Help', command: '/help' },
    ]),
  };
}

function suggestActions(text: string): SuggestedAction[] {
  const normalized = text.toLowerCase();
  const ticker = extractTicker(text);
  const suggestions: SuggestedAction[] = [];

  if (ticker) {
    if (containsAny(normalized, ['news', '新聞', '消息', 'headline'])) {
      suggestions.push({ label: 'News', command: `/n ${ticker} 7` });
      suggestions.push({ label: 'Snapshot', command: `/q ${ticker}` });
    } else if (containsAny(normalized, ['chart', 'graph', 'price', '走勢', '圖', 'kline', 'k線'])) {
      suggestions.push({ label: 'Chart', command: `/chart ${ticker}` });
      suggestions.push({ label: 'Snapshot', command: `/q ${ticker}` });
    } else if (containsAny(normalized, ['flow', 'foreign', 'fini', '買超', '外資', '籌碼', 'momentum'])) {
      suggestions.push({ label: 'Flow', command: `/flow ${ticker} 5d` });
      suggestions.push({ label: 'Snapshot', command: `/q ${ticker}` });
    } else if (containsAny(normalized, ['watch', '追蹤', '關注', '加入'])) {
      suggestions.push({ label: 'Watch', command: `/watch ${ticker}` });
      suggestions.push({ label: 'Watchlist', command: '/watchlist' });
    } else if (containsAny(normalized, ['quality', 'score', '品質'])) {
      suggestions.push({ label: 'Quality', command: `/quality ${ticker}` });
      suggestions.push({ label: 'Snapshot', command: `/q ${ticker}` });
    } else if (containsAny(normalized, ['value', 'valuation', 'pe', 'pb', '估值', '本益比', '股價淨值比'])) {
      suggestions.push({ label: 'Valuation', command: `/valuation ${ticker}` });
      suggestions.push({ label: 'Snapshot', command: `/q ${ticker}` });
    } else {
      suggestions.push({ label: 'Chart', command: `/chart ${ticker}` });
      suggestions.push({ label: 'Snapshot', command: `/q ${ticker}` });
      suggestions.push({ label: 'Flow', command: `/flow ${ticker} 5d` });
      suggestions.push({ label: 'News', command: `/n ${ticker} 7` });
      suggestions.push({ label: 'Watch', command: `/watch ${ticker}` });
    }
  }

  if (containsAny(normalized, ['watchlist', 'watch list', 'my stocks', '追蹤清單', '清單'])) {
    suggestions.push({ label: 'Watchlist', command: '/watchlist' });
    suggestions.push({ label: 'Profile', command: '/profile' });
  }
  if (containsAny(normalized, ['screen', 'find', 'scan', 'oversold', 'momentum', 'foreign', '篩選', '找股票'])) {
    suggestions.push({ label: 'Foreign screen', command: '/screen foreign' });
    suggestions.push({ label: 'Momentum', command: '/screen momentum' });
    suggestions.push({ label: 'Oversold', command: '/screen oversold' });
  }
  if (containsAny(normalized, ['market', 'regime', '大盤', '市場', '盤勢'])) {
    suggestions.push({ label: 'Regime', command: '/regime' });
    suggestions.push({ label: 'Recent news', command: '/recent 1' });
  }
  if (containsAny(normalized, ['setting', 'settings', 'profile', 'tone', 'risk', 'language', '偏好', '設定', '風險', '語言'])) {
    suggestions.push({ label: 'Profile', command: '/profile' });
    suggestions.push({ label: 'Concise', command: '/pref tone concise' });
    suggestions.push({ label: 'TW', command: '/pref lang tw' });
    suggestions.push({ label: 'Conservative', command: '/pref risk conservative' });
  }
  if (containsAny(normalized, ['remind', 'reminder', 'alert', 'brief', 'daily', '通知', '提醒', '簡報'])) {
    suggestions.push({ label: '8:30 brief', command: '/reminder add 08:30 premarket' });
    suggestions.push({ label: '16:30 close', command: '/reminder add 16:30 postclose' });
    suggestions.push({ label: 'Brief now', command: '/brief premarket' });
    suggestions.push({ label: 'Reminders', command: '/reminder list' });
  }

  suggestions.push({ label: 'Help', command: '/help' });
  return dedupeSuggestions(suggestions).slice(0, 8);
}

function buttonsFromSuggestions(source: LineSource | undefined, suggestions: SuggestedAction[]): BotReply['buttons'] {
  if (source?.type === 'group') return [];
  const rows: BotReply['buttons'] = [];
  for (let index = 0; index < suggestions.length; index += 2) {
    rows.push(suggestions.slice(index, index + 2).map((suggestion) => ({
      label: suggestion.label,
      text: suggestion.command,
    })));
  }
  return rows;
}

function helpButtons(source: LineSource | undefined): BotReply['buttons'] {
  if (source?.type === 'group') return [];
  return [
    [{ label: 'Reports', text: '/help reports' }, { label: 'Watchlist', text: '/help watchlist' }],
    [{ label: 'Settings', text: '/help settings' }, { label: 'Advanced', text: '/help advanced' }],
    [{ label: 'Chart', text: '/chart 2330' }, { label: 'Stock report', text: '/q 2330' }],
    [{ label: 'Brief now', text: '/brief premarket' }],
  ];
}

function reportButtons(source: LineSource | undefined): BotReply['buttons'] {
  if (source?.type === 'group') return [];
  return [
    [{ label: 'Chart', text: '/chart 2330' }, { label: 'Stock report', text: '/q 2330' }],
    [{ label: 'Flow', text: '/flow 2330 5d' }, { label: 'News', text: '/n 2330 7' }],
    [{ label: 'Screen', text: '/screen foreign' }, { label: 'Regime', text: '/regime' }],
    [{ label: 'Back', text: '/help' }],
  ];
}

function watchlistButtons(source: LineSource | undefined): BotReply['buttons'] {
  if (source?.type === 'group') return [];
  return [
    [{ label: 'Watchlist', text: '/watchlist' }, { label: 'Add 2330', text: '/watch 2330' }],
    [{ label: 'Brief now', text: '/brief premarket' }, { label: 'Set 8:30', text: '/reminder add 08:30 premarket' }],
    [{ label: 'Reminders', text: '/reminder list' }, { label: 'Back', text: '/help' }],
  ];
}

function settingsButtons(source: LineSource | undefined): BotReply['buttons'] {
  if (source?.type === 'group') return [];
  return [
    [{ label: 'Profile', text: '/profile' }, { label: 'Concise', text: '/pref tone concise' }],
    [{ label: 'TW', text: '/pref lang tw' }, { label: 'Conservative', text: '/pref risk conservative' }],
    [{ label: 'Back', text: '/help' }],
  ];
}

function advancedButtons(source: LineSource | undefined): BotReply['buttons'] {
  if (source?.type === 'group') return [];
  return [
    [{ label: 'Backtest', text: '/backtest rsi_14 40 below 5' }, { label: 'Alpha', text: '/alpha 2330' }],
    [{ label: 'Factor', text: '/factor semiconductor' }, { label: 'Lead lag', text: '/leadlag 2330' }],
    [{ label: 'Status', text: '/status' }, { label: 'Back', text: '/help' }],
  ];
}

function tickerReportButtons(source: LineSource | undefined, ticker: string): BotReply['buttons'] {
  if (source?.type === 'group') return [];
  return [
    [{ label: 'Chart', text: `/chart ${ticker}` }, { label: 'News', text: `/n ${ticker} 7` }],
    [{ label: 'Flow', text: `/flow ${ticker} 5d` }, { label: 'Watch', text: `/watch ${ticker}` }],
    [{ label: 'Brief', text: '/brief premarket' }, { label: 'Reports', text: '/help reports' }],
  ];
}

function buttonsFor(source: LineSource | undefined): BotReply['buttons'] {
  if (source?.type === 'group') return [];
  return [
    [{ label: 'Chart', text: '/chart 2330' }, { label: 'Stock report', text: '/q 2330' }],
    [{ label: 'Watchlist', text: '/watchlist' }, { label: 'Brief', text: '/brief premarket' }],
    [{ label: 'Settings', text: '/help settings' }, { label: 'Help', text: '/help' }],
  ];
}

function assertCanWrite(source: LineSource | undefined, toolName: string) {
  const allowlist = (process.env.MCP_AGENT_WRITE_USER_IDS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const openWrites = process.env.MCP_AGENT_ALLOW_WRITES_WITHOUT_USER_ALLOWLIST === 'true';
  if (allowlist.length === 0 && openWrites) return;
  if (source?.userId && allowlist.includes(source.userId)) return;
  throw new Error(`${toolName} is write-capable. Add your LINE user id to MCP_AGENT_WRITE_USER_IDS, or set MCP_AGENT_ALLOW_WRITES_WITHOUT_USER_ALLOWLIST=true for personal deployments.`);
}

function requireProfileKey(source: LineSource | undefined, runtime: LineWebhookRuntime) {
  if (!source?.userId) throw new Error('LINE user id is required for personal watchlist and settings. Try this command in a 1:1 chat or a group where LINE includes user ids.');
  return {
    tenantId: runtime.tenant.id,
    channelId: runtime.channel.id,
    platform: 'line' as const,
    userId: source.userId,
  };
}

function profileReply(source: LineSource | undefined, runtime: LineWebhookRuntime): BotReply {
  const profile = getPersonalProfile(requireProfileKey(source, runtime));
  return {
    text: formatProfile(profile),
    buttons: buttonsFor(source),
  };
}

function updateProfilePreferences(args: string[], source: LineSource | undefined, runtime: LineWebhookRuntime): BotReply {
  if (!args.length) {
    return {
      text: 'Usage\n/pref tone concise|balanced|technical\n/pref lang tw|en\n/pref risk conservative|balanced|aggressive',
      buttons: buttonsFor(source),
    };
  }
  const key = requireProfileKey(source, runtime);
  let language: PersonalLanguage | undefined;
  let tone: PersonalTone | undefined;
  let risk: PersonalRisk | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const field = args[index]?.toLowerCase();
    const value = args[index + 1]?.toLowerCase();
    if ((field === 'lang' || field === 'language') && isPersonalLanguage(value)) {
      language = value;
      index += 1;
    } else if (field === 'tone' && isPersonalTone(value)) {
      tone = value;
      index += 1;
    } else if (field === 'risk' && isPersonalRisk(value)) {
      risk = value;
      index += 1;
    } else if (isPersonalLanguage(field)) {
      language = field;
    } else if (isPersonalTone(field)) {
      tone = field;
    } else if (isPersonalRisk(field)) {
      risk = field;
    }
  }

  if (!language && !tone && !risk) {
    return {
      text: 'No valid preference found.\n\nExamples:\n/pref tone concise\n/pref lang tw\n/pref risk conservative',
      buttons: buttonsFor(source),
    };
  }

  const profile = setPersonalPreferences({ ...key, language, tone, risk });
  return {
    text: `Preference saved.\n\n${formatProfile(profile)}`,
    buttons: buttonsFor(source),
  };
}

function reminderReply(args: string[], source: LineSource | undefined, runtime: LineWebhookRuntime): BotReply {
  const key = requireProfileKey(source, runtime);
  const profile = getPersonalProfile(key);
  const action = (args[0] ?? 'list').toLowerCase();

  if (action === 'list' || action === 'ls') return formatReminderList(profile, source);

  if (action === 'add' || action === 'set') {
    const time = normalizeReminderTime(args[1]);
    const template = parseBriefTemplate(args[2]) ?? 'premarket';
    if (!time) return reminderUsageReply(source);
    const updated = upsertBriefReminder({ ...key, time, template, timezone: 'Asia/Taipei', enabled: true });
    return {
      text: joinLines([
        `Reminder saved: ${time} Asia/Taipei, ${template}`,
        '',
        formatReminderLines(updated),
      ]),
      buttons: reminderButtons(source),
    };
  }

  if (action === 'off' || action === 'pause' || action === 'on' || action === 'resume') {
    const id = args[1];
    if (!id) return reminderUsageReply(source);
    const { profile: updated, updated: didUpdate } = setBriefReminderEnabled({ ...key, id, enabled: action === 'on' || action === 'resume' });
    return {
      text: didUpdate ? formatReminderLines(updated) : `No reminder found for id: ${id}`,
      buttons: reminderButtons(source),
    };
  }

  if (action === 'delete' || action === 'del' || action === 'remove') {
    const id = args[1];
    if (!id) return reminderUsageReply(source);
    const { profile: updated, removed } = removeBriefReminder({ ...key, id });
    return {
      text: removed ? formatReminderLines(updated) : `No reminder found for id: ${id}`,
      buttons: reminderButtons(source),
    };
  }

  const shorthandTime = normalizeReminderTime(args[0]);
  if (shorthandTime) {
    const template = parseBriefTemplate(args[1]) ?? 'premarket';
    const updated = upsertBriefReminder({ ...key, time: shorthandTime, template, timezone: 'Asia/Taipei', enabled: true });
    return {
      text: joinLines([`Reminder saved: ${shorthandTime} Asia/Taipei, ${template}`, '', formatReminderLines(updated)]),
      buttons: reminderButtons(source),
    };
  }

  return reminderUsageReply(source);
}

function personalWatchlistReply(source: LineSource | undefined, runtime: LineWebhookRuntime): BotReply {
  const profile = getPersonalProfile(requireProfileKey(source, runtime));
  if (!profile.watchlist.length) {
    return {
      text: 'Your personal watchlist is empty.\n\nAdd one:\n/watch 2330 reason',
      buttons: buttonsFor(source),
    };
  }
  return {
    text: joinLines([
      `Your watchlist (${profile.watchlist.length})`,
      ...profile.watchlist.map((item) => {
        const meta = [item.companyName, item.pillar, item.node].filter(Boolean).join(' / ');
        return `- ${item.ticker}${meta ? ` ${meta}` : ''}${item.reason ? ` - ${item.reason.slice(0, 120)}` : ''}`;
      }),
    ]),
    buttons: buttonsFor(source),
  };
}

function formatReminderList(profile: PersonalProfile, source: LineSource | undefined): BotReply {
  return {
    text: profile.briefReminders.length
      ? formatReminderLines(profile)
      : 'No watchlist brief reminders yet.\n\nAdd one:\n/reminder add 08:30 premarket',
    buttons: reminderButtons(source),
  };
}

function reminderUsageReply(source: LineSource | undefined): BotReply {
  return {
    text: joinLines([
      'Reminder commands',
      '/reminder add 08:30 premarket',
      '/reminder add 12:30 midday',
      '/reminder add 16:30 postclose',
      '/reminder add 21:00 risk',
      '/reminder list',
      '/reminder off <id>',
      '/reminder delete <id>',
      '/brief premarket',
      '',
      'Templates: premarket, midday, postclose, risk, news, flow',
    ]),
    buttons: reminderButtons(source),
  };
}

function reminderButtons(source: LineSource | undefined): BotReply['buttons'] {
  if (source?.type === 'group') return [];
  return [
    [{ label: '8:30 premarket', text: '/reminder add 08:30 premarket' }, { label: '12:30 midday', text: '/reminder add 12:30 midday' }],
    [{ label: '16:30 close', text: '/reminder add 16:30 postclose' }, { label: '21:00 risk', text: '/reminder add 21:00 risk' }],
    [{ label: 'List', text: '/reminder list' }, { label: 'Brief now', text: '/brief premarket' }],
  ];
}

function formatReminderLines(profile: PersonalProfile) {
  if (!profile.briefReminders.length) return 'No reminders configured.';
  return joinLines([
    `Watchlist brief reminders (${profile.briefReminders.length})`,
    ...profile.briefReminders.map((item) => `- ${item.id} ${item.enabled ? 'on' : 'off'} ${item.time} ${item.timezone} ${item.template}`),
  ]);
}

function formatProfile(profile: PersonalProfile) {
  return joinLines([
    'Personal profile',
    `Language: ${profile.language}`,
    `Tone: ${profile.tone}`,
    `Risk: ${profile.risk}`,
    `Watchlist: ${profile.watchlist.length} ticker${profile.watchlist.length === 1 ? '' : 's'}`,
    '',
    'Commands:',
    '/pref tone concise|balanced|technical',
    '/pref lang tw|en',
    '/pref risk conservative|balanced|aggressive',
  ]);
}

function formatPersonalWatchAdded(profile: PersonalProfile, ticker: string) {
  const item = profile.watchlist.find((entry) => entry.ticker === ticker);
  return joinLines([
    `Added ${ticker} to your personal watchlist.`,
    item?.companyName ? `${item.companyName} ${item.pillar ?? ''}${item.node ? ` / ${item.node}` : ''}`.trim() : undefined,
    item?.reason ? `Reason: ${item.reason}` : undefined,
    `Your watchlist now has ${profile.watchlist.length} ticker${profile.watchlist.length === 1 ? '' : 's'}.`,
  ]);
}

function formatPersonalWatchRemoved(profile: PersonalProfile, ticker: string) {
  return `Removed ${ticker} from your personal watchlist.\n\nRemaining: ${profile.watchlist.length}`;
}

function firstCompanyMeta(result: unknown, ticker: string) {
  const rows = objectArray(result, ['companies', 'rows']);
  const row = rows.find((item) => stringValue(item.ticker_id)?.toUpperCase() === ticker) ?? rows[0];
  return row ? {
    companyName: stringValue(row.company_name ?? row.name),
    pillar: stringValue(row.ai_pillar ?? row.pillar),
    node: stringValue(row.node),
  } : {};
}

function decorateReplyForProfile(reply: BotReply, source: LineSource | undefined, runtime: LineWebhookRuntime, commandName: McpAgentCommandName): BotReply {
  if (!source?.userId || commandName === 'help' || commandName === 'profile' || commandName === 'pref' || commandName === 'whoami') return reply;
  const profile = getPersonalProfile(requireProfileKey(source, runtime));
  let text = reply.text;
  if (profile.tone === 'concise' && text.length > 1600) {
    text = `${text.slice(0, 1550)}\n\n[Concise mode: trimmed]`;
  }
  const header = profile.language === 'tw'
    ? `個人模式：${toneLabel(profile.tone, 'tw')} / ${riskLabel(profile.risk, 'tw')}`
    : `Personal mode: ${profile.tone} / ${profile.risk}`;
  return {
    ...reply,
    text: joinSections([header, text]),
  };
}

function isPersonalLanguage(value: string | undefined): value is PersonalLanguage {
  return value === 'en' || value === 'tw';
}

function isPersonalTone(value: string | undefined): value is PersonalTone {
  return value === 'concise' || value === 'balanced' || value === 'technical';
}

function isPersonalRisk(value: string | undefined): value is PersonalRisk {
  return value === 'conservative' || value === 'balanced' || value === 'aggressive';
}

function toneLabel(tone: PersonalTone, language: PersonalLanguage) {
  if (language === 'en') return tone;
  if (tone === 'concise') return '精簡';
  if (tone === 'technical') return '技術';
  return '平衡';
}

function riskLabel(risk: PersonalRisk, language: PersonalLanguage) {
  if (language === 'en') return risk;
  if (risk === 'conservative') return '保守';
  if (risk === 'aggressive') return '積極';
  return '平衡';
}

function extractTicker(text: string) {
  const normalized = text.toLowerCase();
  for (const [alias, ticker] of tickerAliases) {
    if (normalized.includes(alias)) return ticker;
  }
  const tickerLike = text.match(/(?:^|[^0-9A-Za-z])([0-9]{4}[A-Za-z]?|00[0-9]{2,3}[A-Za-z]?)(?=$|[^0-9A-Za-z])/);
  return parseTicker(tickerLike?.[1]);
}

function containsAny(text: string, needles: string[]) {
  return needles.some((needle) => text.includes(needle));
}

function dedupeSuggestions(suggestions: SuggestedAction[]) {
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    if (seen.has(suggestion.command)) return false;
    seen.add(suggestion.command);
    return true;
  });
}

function parseTicker(value: string | undefined) {
  const ticker = value?.trim().toUpperCase();
  return ticker && /^[0-9A-Z]+[A-Z]?$/.test(ticker) ? ticker : undefined;
}

function parseWindow(value: string | undefined) {
  const window = value?.toLowerCase();
  return window && validWindows.has(window) ? window : '5d';
}

function parseLimit(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, Math.round(parsed)));
}

function stockChartUrl(input: { ticker: string; days: number; tenantId: string; channelId: string }) {
  const baseUrl = publicBaseUrl().replace(/\/$/, '');
  const params = new URLSearchParams({
    ticker: input.ticker,
    days: String(input.days),
    tenant: input.tenantId,
    channel: input.channelId,
  });
  return `${baseUrl}/api/stock-chart?${params.toString()}`;
}

function publicBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'https://tecxbot.vercel.app';
}

function parseBriefTemplate(value: string | undefined): WatchlistBriefTemplate | undefined {
  const template = value?.toLowerCase();
  if (template === 'premarket' || template === 'pre' || template === 'morning') return 'premarket';
  if (template === 'midday' || template === 'noon') return 'midday';
  if (template === 'postclose' || template === 'close' || template === 'closing' || template === 'afterclose') return 'postclose';
  if (template === 'risk') return 'risk';
  if (template === 'news') return 'news';
  if (template === 'flow' || template === 'flows') return 'flow';
  return undefined;
}

function normalizeReminderTime(value: string | undefined) {
  const match = value?.trim().match(/^([01]?\d|2[0-3])(?::?([0-5]\d))$/);
  if (!match) return undefined;
  const hour = match[1].padStart(2, '0');
  const minute = (match[2] ?? '00').padStart(2, '0');
  return `${hour}:${minute}`;
}

function objectArray(result: unknown, keys: string[]) {
  const record = asRecord(result);
  for (const key of keys) {
    const rows = record?.[key];
    if (Array.isArray(rows)) return rows.filter(isRecord);
  }
  return Array.isArray(result) ? result.filter(isRecord) : [];
}

function firstObject(result: unknown, keys: string[]) {
  const rows = objectArray(result, keys);
  return rows[0];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stockLabel(row: Record<string, unknown>) {
  return [stringValue(row.ticker_id), stringValue(row.company_name ?? row.name)].filter(Boolean).join(' ') || '-';
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function metricLine(row: Record<string, unknown>, pairs: Array<[string, string]>) {
  const parts = pairs.map(([label, key]) => `${label} ${fmt(row[key])}`);
  return parts.join(' | ');
}

function compactSubscores(value: unknown) {
  const record = asRecord(value);
  if (!record) return undefined;
  return Object.entries(record).map(([key, val]) => `${key}: ${fmt(val)}`).join(' | ');
}

function fmt(value: unknown) {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string' && value.trim()) return value.trim();
  return '-';
}

function fmtPct(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return `${value.toFixed(2)}%`;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return `${parsed.toFixed(2)}%`;
  }
  return '-';
}

function joinSections(sections: Array<string | undefined>) {
  return sections.filter((section): section is string => Boolean(section?.trim())).join('\n\n').slice(0, 3800);
}

function joinLines(lines: Array<string | undefined>) {
  return lines.filter((line): line is string => Boolean(line?.trim())).join('\n').slice(0, 3800);
}

function compactJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
