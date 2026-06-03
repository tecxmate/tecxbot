import { appendMessage, closeSession, getSession, isSessionActive } from '../../core/sessionStore.js';
import { appendGroupContextMessage, getGroupTranslationSettings, isUserTranslationEnabled, setGroupTranslationLanguages, setUserTranslationEnabled } from '../../core/groupTranslationStore.js';
import { catchUpGroupMessages, extractGroupActions, summarizeGroupMessages, type GroupActions, type GroupCatchup, type GroupSummary } from '../../core/groupSummary.js';
import { getLanguageLabel, listLanguageCodes, normalizeLanguageCode } from '../../core/languages.js';
import { getTenantConfig } from '../../core/tenantStore.js';
import { polishTranscript, transcribeWithDeepgram } from '../../core/transcription.js';
import { translateGroupMessage } from '../../core/translation.js';
import type { BotReply, TenantChannelConfig, TenantConfig, TranscriptLanguage } from '../../core/types.js';
import { canConsumeCharacters, consumeCharacters, getRemainingCharacters } from '../../core/usageStore.js';
import { handleMcpAgentLineEvent } from '../../botSystems/mcpAgent.js';
import { handleVietnameseTeacherLineEvent } from '../../botSystems/vietnameseTeacher.js';
import { handleTecxmateLineEvent } from '../../botSystems/tecxmate.js';
import { downloadLineMessageContent, mainMenuButtons, replyLineMessage } from './client.js';
import type { LineEvent, LineMessage, LineSource, LineWebhookPayload } from './types.js';

export type { LineWebhookPayload };

export type LineWebhookRuntime = {
  tenant: TenantConfig;
  channel: TenantChannelConfig;
};

export async function handleLineWebhook(payload: LineWebhookPayload, runtime: LineWebhookRuntime) {
  let processed = 0;
  for (const event of payload.events ?? []) {
    const replyToken = 'replyToken' in event ? event.replyToken : undefined;
    if (!replyToken) continue;
    const reply = await handleLineEvent(event, runtime);
    if (reply) {
      await replyLineMessage(replyToken, reply, runtime.channel.line?.channelAccessToken);
      processed += 1;
    }
  }
  return processed;
}

async function handleLineEvent(event: LineEvent, runtime: LineWebhookRuntime): Promise<BotReply | undefined> {
  if (runtime.channel.botSystem.kind === 'mcp_agent') return handleMcpAgentLineEvent(event, runtime);
  if (runtime.channel.botSystem.kind === 'vietnamese_teacher') return handleVietnameseTeacherLineEvent(event, runtime);
  if (runtime.channel.botSystem.kind === 'tecxmate') return handleTecxmateLineEvent(event, runtime);
  const tenant = runtime.tenant;
  const source = event.source;
  const session = getSession({ tenantId: tenant.id, platform: 'line', sourceType: source?.type ?? 'user', sourceId: source?.groupId ?? source?.roomId ?? source?.userId ?? 'unknown', userId: source?.userId });
  if (event.type === 'follow' || event.type === 'join') return welcomeReply(source, tenant);
  if (event.type === 'postback' && 'postback' in event) return handlePostback(event.postback?.data ?? '', source, session, tenant, runtime);
  if (event.type !== 'message') return undefined;
  if (!('message' in event)) return undefined;
  return handleMessage(event.message, source, session, tenant, runtime);
}

async function handleMessage(message: LineMessage, source: LineSource | undefined, session: ReturnType<typeof getSession>, tenant: TenantConfig, runtime: LineWebhookRuntime) {
  if (message.type === 'text') {
    const groupReply = await handleGroupTranslationText(message.text, source, tenant);
    if (groupReply) return groupReply;
    const mention = normalizeMention(message.text, source, session, tenant.botMentionNames);
    if (!mention.shouldReply) return undefined;
    const text = mention.text.trim();
    if (!text) return undefined;
    appendMessage(session, 'user', text);
    if (isClosePhrase(text)) {
      closeSession(session);
      return { text: '已結束這次對話。需要時可再點下方選單。', buttons: source?.type === 'group' ? [] : mainMenuButtons() };
    }
    const menu = handleMenuText(text, source, tenant);
    if (menu) {
      appendMessage(session, 'assistant', menu.text);
      return menu;
    }
    const reply = source?.type === 'user'
      ? directOnboardingReply()
      : helpReply(source, tenant);
    appendMessage(session, 'assistant', reply.text);
    return reply;
  }
  if (message.type === 'audio' || message.type === 'video' || message.type === 'file') {
    if (source?.type !== 'user' && !isSessionActive(session)) return undefined;
    session.audio = { platformMessageId: message.id, mediaType: message.type, fileName: message.fileName, fileSize: message.fileSize, durationMs: message.duration, createdAt: Date.now() };
    session.currentWorkflow = 'audio_transcript';
    session.currentStep = 'confirm';
    return { text: `偵測到音檔。\n\ntype: ${message.type}\nfile_name: ${message.fileName ?? 'unknown'}\nduration: ${message.duration ? Math.round(message.duration / 1000) + ' sec' : 'unknown'}\nsize: ${message.fileSize ? Math.round(message.fileSize / 1024 / 1024 * 10) / 10 + ' MB' : 'unknown'}\n\n要開始轉文字嗎？`, buttons: [[{ label: '是，開始轉文字', data: 'audio:confirm' }, { label: '否，先不要', data: 'audio:ignore' }]] };
  }
  return { text: '目前這個訊息類型尚未支援。', buttons: source?.type === 'group' ? [] : mainMenuButtons() };
}

async function handleGroupTranslationText(text: string, source: LineSource | undefined, tenant: ReturnType<typeof getTenantConfig>): Promise<BotReply | undefined> {
  if (source?.type !== 'group' || !source.groupId) return undefined;
  const command = parseTranslationCommand(text);
  if (command) return handleTranslationCommand(command, source, tenant);
  const settings = ensureGroupSettings({ tenantId: tenant.id, groupId: source.groupId });
  if (isLikelyCommand(text)) return undefined;
  appendGroupContextMessage(settings, { userId: source.userId, text });
  if (settings.targetLanguages.length < 2 || !isUserTranslationEnabled(settings, source.userId)) return undefined;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { text: 'OPENAI_API_KEY 尚未設定，無法翻譯。', buttons: [] };
  const characters = countBillableCharacters(text, settings.targetLanguages.length);
  if (!canConsumeCharacters(tenant.id, tenant.freePlan, characters)) {
    const remaining = getRemainingCharacters(tenant.id, tenant.freePlan);
    return { text: `本期翻譯額度已不足。\n\n剩餘字元：${remaining}\n需要字元：${characters}\n\n請升級方案或等待額度重置。`, buttons: [[{ label: '查看方案', url: process.env.PUBLIC_PRICING_URL || 'https://example.com/pricing' }]] };
  }
  try {
    const result = await translateGroupMessage({ apiKey, tenant, text, targetLanguages: settings.targetLanguages, contextMessages: settings.recentMessages.slice(0, -1) });
    consumeCharacters(tenant.id, tenant.freePlan, characters);
    const normalizedInput = normalizeForCompare(text);
    const translated = result.translations.filter((item) => item.text.trim() && item.language !== result.sourceLanguage && normalizeForCompare(item.text) !== normalizedInput);
    if (translated.length === 0) return undefined;
    return { text: formatTranslationReply(translated) };
  } catch (error) {
    console.error('[line-translation] Failed:', error);
    return { text: `翻譯失敗：${formatError(error)}`, buttons: [] };
  }
}

async function handleTranslationCommand(command: TranslationCommand, source: LineSource, tenant: ReturnType<typeof getTenantConfig>): Promise<BotReply> {
  if (source.type !== 'group' || !source.groupId) return { text: '翻譯設定只能在 LINE 群組中使用。', buttons: [] };
  if (command.name === 'help') return helpReply(source, tenant);
  if (command.name === 'menu') return menuReply('main', source, tenant);
  if (command.name === 'settings') return menuReply('settings', source, tenant);
  if (command.name === 'summary') return handleSummaryCommand(command, source, tenant);
  if (command.name === 'actions') return handleActionsCommand(command, source, tenant);
  if (command.name === 'catchup') return handleCatchupCommand(command, source, tenant);
  if (command.name === 'set') {
    if (command.args.length < 2 || command.args.length > 5) return { text: `請設定 2 到 5 種語言，例如：\n/set en tw ja\n\n支援代碼：${listLanguageCodes()}`, buttons: [] };
    const languages = command.args.map(normalizeLanguageCode);
    if (languages.some((language) => !language)) return { text: `有不支援的語言代碼。\n\n支援代碼：${listLanguageCodes()}`, buttons: [] };
    const settings = setGroupTranslationLanguages({ tenantId: tenant.id, platform: 'line', groupId: source.groupId, languageCodes: command.args });
    return { text: `群組翻譯已啟用。\n\n語言：${settings.targetLanguages.map(getLanguageLabel).join(' / ')}\n\n/status 查看額度；/off 暫停翻譯你的訊息。`, buttons: [] };
  }
  if (command.name === 'on' || command.name === 'off') {
    if (!source.userId) return { text: '找不到你的 LINE user id，無法更新個人翻譯狀態。' };
    const settings = setUserTranslationEnabled({ tenantId: tenant.id, platform: 'line', groupId: source.groupId, userId: source.userId, enabled: command.name === 'on' });
    if (!settings) return { text: '這個群組尚未設定翻譯語言。請先傳送：/set en tw', buttons: [] };
    return { text: command.name === 'on' ? '已開啟你的訊息翻譯。' : '已暫停翻譯你的訊息。', buttons: [] };
  }
  if (command.name === 'status') {
    const settings = getGroupTranslationSettings({ tenantId: tenant.id, platform: 'line', groupId: source.groupId });
    const remaining = getRemainingCharacters(tenant.id, tenant.freePlan);
    return { text: `翻譯狀態\n\n語言：${settings?.targetLanguages.length ? settings.targetLanguages.map(getLanguageLabel).join(' / ') : '尚未設定'}\n方案：${tenant.freePlan.name}\n本期剩餘字元：${remaining}`, buttons: [] };
  }
  if (command.name === 'languages') return { text: `支援語言代碼：\n${listLanguageCodes()}`, buttons: [] };
  return helpReply(source, tenant);
}

const DEFAULT_TRANSLATION_LANGUAGES = ['en', 'tw'];

function ensureGroupSettings(input: { tenantId: string; groupId: string }) {
  return getGroupTranslationSettings({ tenantId: input.tenantId, platform: 'line', groupId: input.groupId })
    ?? setGroupTranslationLanguages({ tenantId: input.tenantId, platform: 'line', groupId: input.groupId, languageCodes: DEFAULT_TRANSLATION_LANGUAGES });
}

async function handleSummaryCommand(command: TranslationCommand, source: LineSource, tenant: ReturnType<typeof getTenantConfig>): Promise<BotReply> {
  if (source.type !== 'group' || !source.groupId) return { text: '請在 LINE 群組內使用 /summary。', buttons: [] };
  const settings = ensureGroupSettings({ tenantId: tenant.id, groupId: source.groupId });
  const limit = parseSummaryLimit(command.args[0]);
  const messages = settings.recentMessages.slice(-limit);
  if (messages.length < 2) return { text: '目前可摘要的群組訊息還太少。多聊幾句後再輸入 /summary。', buttons: [] };
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { text: 'OPENAI_API_KEY 尚未設定，無法產生摘要。', buttons: [] };
  try {
    const summary = await summarizeGroupMessages({ apiKey, tenant, messages, limit });
    return { text: formatSummaryReply(summary, messages.length), buttons: [] };
  } catch (error) {
    console.error('[line-summary] Failed:', error);
    return { text: `摘要失敗：${formatError(error)}`, buttons: [] };
  }
}

async function handleActionsCommand(command: TranslationCommand, source: LineSource, tenant: ReturnType<typeof getTenantConfig>): Promise<BotReply> {
  if (source.type !== 'group' || !source.groupId) return { text: '請在 LINE 群組內使用 /actions。', buttons: [] };
  const settings = ensureGroupSettings({ tenantId: tenant.id, groupId: source.groupId });
  const limit = parseSummaryLimit(command.args[0]);
  const messages = settings.recentMessages.slice(-limit);
  if (messages.length < 2) return { text: '目前可整理的群組訊息還太少。多聊幾句後再輸入 /actions。', buttons: [] };
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { text: 'OPENAI_API_KEY 尚未設定，無法整理 action items。', buttons: [] };
  try {
    const actions = await extractGroupActions({ apiKey, tenant, messages, limit });
    return { text: formatActionsReply(actions, messages.length), buttons: [] };
  } catch (error) {
    console.error('[line-actions] Failed:', error);
    return { text: `Action items 整理失敗：${formatError(error)}`, buttons: [] };
  }
}

async function handleCatchupCommand(command: TranslationCommand, source: LineSource, tenant: ReturnType<typeof getTenantConfig>): Promise<BotReply> {
  if (source.type !== 'group' || !source.groupId) return { text: '請在 LINE 群組內使用 /catchup。', buttons: [] };
  const settings = ensureGroupSettings({ tenantId: tenant.id, groupId: source.groupId });
  const limit = parseSummaryLimit(command.args[0]);
  const messages = settings.recentMessages.slice(-limit);
  if (messages.length < 2) return { text: '目前可整理的群組訊息還太少。多聊幾句後再輸入 /catchup。', buttons: [] };
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { text: 'OPENAI_API_KEY 尚未設定，無法產生 catchup。', buttons: [] };
  try {
    const catchup = await catchUpGroupMessages({ apiKey, tenant, messages, limit });
    return { text: formatCatchupReply(catchup, messages.length), buttons: [] };
  } catch (error) {
    console.error('[line-catchup] Failed:', error);
    return { text: `Catchup 失敗：${formatError(error)}`, buttons: [] };
  }
}

async function handlePostback(data: string, source: LineSource | undefined, session: ReturnType<typeof getSession>, tenant: TenantConfig, runtime: LineWebhookRuntime): Promise<BotReply> {
  const parsed = parsePostback(data);
  if (parsed.action === 'menu') return menuReply(parsed.value, source, tenant);
  if (parsed.action === 'settings') return handleSettingsPostback(parsed.value, source, tenant);
  if (parsed.action === 'audio') {
    if (parsed.value === 'ignore') {
      session.audio = undefined;
      return { text: '已取消這個音檔，不會送去轉文字。', buttons: mainMenuButtons() };
    }
    if (parsed.value === 'confirm') {
      if (!session.audio) return { text: '找不到剛剛的音檔，請重新上傳一次。', buttons: mainMenuButtons() };
      return { text: '請選擇這個音檔的主要語言：', buttons: [[{ label: 'English', data: 'audio_language:en' }, { label: '繁體中文', data: 'audio_language:zh-TW' }]] };
    }
  }
  if (parsed.action === 'audio_language') return processAudio(session, tenant, parsed.value === 'en' ? 'en' : 'zh-TW', runtime);
  if (parsed.action === 'polish_transcript') {
    if (!session.transcript?.rawText) return { text: '找不到剛剛的 raw transcript，請重新上傳音檔。', buttons: mainMenuButtons() };
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { text: 'OPENAI_API_KEY 尚未設定，無法整理 transcript。', buttons: mainMenuButtons() };
    const polished = await polishTranscript({ apiKey, tenant, rawTranscript: session.transcript.rawText, language: session.transcript.language });
    return { text: `Current step: Polished transcript ready\n\n${polished.slice(0, 1800)}`, buttons: mainMenuButtons() };
  }
  return { text: '收到操作，但目前尚未啟用對應流程。', buttons: mainMenuButtons() };
}

async function processAudio(session: ReturnType<typeof getSession>, tenant: TenantConfig, language: TranscriptLanguage, runtime: LineWebhookRuntime): Promise<BotReply> {
  if (!session.audio) return { text: '找不到剛剛的音檔，請重新上傳一次。', buttons: mainMenuButtons() };
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return { text: 'DEEPGRAM_API_KEY 尚未設定，無法轉文字。', buttons: mainMenuButtons() };
  try {
    const media = await downloadLineMessageContent(session.audio.platformMessageId, runtime.channel.line?.channelAccessToken);
    const result = await transcribeWithDeepgram({ apiKey, audio: media.content, contentType: media.contentType, language });
    const rawText = result.transcript.trim();
    session.transcript = { rawText, language, createdAt: Date.now() };
    return { text: `Current step: Raw transcript ready\n\nDeepgram 轉文字完成\n\nlanguage: ${language === 'en' ? 'English' : '繁體中文'}\ncontent_type: ${media.contentType}\nspeakers: ${result.speakers.length || 'unknown'}\n\nRaw transcript preview:\n${rawText ? rawText.slice(0, 2800) : 'Deepgram 沒有回傳可用 transcript。'}`, buttons: [[{ label: '整理 transcript', data: 'polish_transcript:start' }, { label: 'AI 助理', data: 'menu:ai' }]] };
  } catch (error) {
    return { text: `音檔已收到，但處理失敗：${formatError(error)}`, buttons: mainMenuButtons() };
  }
}

function welcomeReply(source: LineSource | undefined, tenant: ReturnType<typeof getTenantConfig>): BotReply {
  if (source?.type !== 'group') return directOnboardingReply();
  return {
    text: `Tecxbot 已加入群組。\n\n預設已開啟 英文 / 繁體中文 翻譯，直接聊天就會自動翻譯。\n\n想換語言：/set en tw ja\n說明：/help`,
    buttons: [],
  };
}

function helpReply(source?: LineSource, tenant = getTenantConfig()): BotReply {
  if (source?.type !== 'group') return directOnboardingReply();
  return {
    text: `群組指令\n\n/help 說明\n/settings 設定說明\n/set en tw ja 設定翻譯語言\n/status 查看語言與額度\n/languages 查看語言代碼\n/summary 摘要最近對話\n/actions 整理 action items\n/catchup 快速補進度\n/off 暫停翻譯你的訊息\n/on 恢復翻譯你的訊息`,
    buttons: [],
  };
}

function settingsMenuReply(source: LineSource | undefined, tenant: ReturnType<typeof getTenantConfig>): BotReply {
  if (source?.type !== 'group') return directOnboardingReply();
  const settings = source?.type === 'group' && source.groupId ? getGroupTranslationSettings({ tenantId: tenant.id, platform: 'line', groupId: source.groupId }) : undefined;
  const remaining = getRemainingCharacters(tenant.id, tenant.freePlan);
  return {
    text: `Settings\n\nLanguages: ${settings?.targetLanguages.length ? settings.targetLanguages.map(getLanguageLabel).join(' / ') : 'not set'}\nPlan: ${tenant.freePlan.name}\nRemaining characters: ${remaining}\n\n設定語言：/set en tw ja\n摘要對話：/summary\n整理任務：/actions\n快速補進度：/catchup\n個人暫停：/off\n個人恢復：/on`,
    buttons: [],
  };
}

async function handleSettingsPostback(value: string, source: LineSource | undefined, tenant: ReturnType<typeof getTenantConfig>): Promise<BotReply> {
  if (source?.type !== 'group') return directOnboardingReply();
  if (value === 'main') return settingsMenuReply(source, tenant);
  if (value === 'languages') return { text: `Language setup\n\nType:\n/set en tw ja\n\nSupported codes:\n${listLanguageCodes()}`, buttons: [] };
  if (value === 'personal') return { text: 'Personal controls\n\n/off pauses translation for messages you send.\n/on turns your messages back on.', buttons: [] };
  if (value === 'usage') return handleTranslationCommand({ name: 'status', args: [] }, source ?? { type: 'user' }, tenant);
  if (value.startsWith('preset:')) {
    if (source?.type !== 'group' || !source.groupId) return { text: '請在 LINE 群組內設定翻譯語言。', buttons: [] };
    const languageCodes = value.slice('preset:'.length).split(',');
    const settings = setGroupTranslationLanguages({ tenantId: tenant.id, platform: 'line', groupId: source.groupId, languageCodes });
    return { text: `群組翻譯已啟用。\n\n語言：${settings.targetLanguages.map(getLanguageLabel).join(' / ')}`, buttons: [] };
  }
  return settingsMenuReply(source, tenant);
}

function settingsButtons(): BotReply['buttons'] {
  return [[{ label: 'Languages', data: 'settings:languages' }, { label: 'Usage', data: 'settings:usage' }], [{ label: 'Personal', data: 'settings:personal' }, { label: 'Back', data: 'menu:main' }]];
}

function languageSetupButtons(): BotReply['buttons'] {
  return [[{ label: 'EN/TW', text: '/set en tw' }, { label: 'EN/TW/JA', text: '/set en tw ja' }], [{ label: 'EN/TW/TH', text: '/set en tw th' }, { label: 'EN/JA/KO', text: '/set en ja ko' }], [{ label: 'More codes', text: '/languages' }, { label: 'Back', data: 'settings:main' }]];
}

function directOnboardingReply(): BotReply {
  return {
    text: `Tecxbot 是群組翻譯 bot。\n\n在一對一聊天不能設定翻譯，因為我需要知道要翻譯哪一個 LINE 群組。\n\n使用方式：\n1. 把 Tecxbot 邀請進 LINE 群組\n2. 在群組輸入 /set en tw ja\n3. 群組開始聊天，我會自動翻譯\n4. 用 /summary、/actions、/catchup 整理對話\n\n這裡可以查看設定方式與語言代碼。`,
    buttons: [[{ label: 'How to setup', data: 'menu:help' }, { label: 'Language codes', text: '/languages' }]],
  };
}

function handleDirectSlashCommand(normalized: string): BotReply | undefined {
  const command = parseTranslationCommand(normalized);
  if (!command) return { text: 'Unknown command. Use /help to see available commands.', buttons: mainMenuButtons() };
  if (command.name === 'help') return helpReply();
  if (command.name === 'menu') return menuReply('main');
  if (command.name === 'settings') return menuReply('settings');
  if (command.name === 'languages') return { text: `語言代碼\n${listLanguageCodes()}\n\n設定語言請先把我邀請進 LINE 群組，再在群組輸入 /set en tw ja。`, buttons: [[{ label: 'Setup guide', data: 'menu:help' }]] };
  if (command.name === 'set' || command.name === 'status' || command.name === 'on' || command.name === 'off' || command.name === 'summary' || command.name === 'actions' || command.name === 'catchup') return directOnboardingReply();
  return undefined;
}

function handleMenuText(text: string, source?: LineSource, tenant = getTenantConfig()): BotReply | undefined {
  const normalized = text.trim().toLowerCase();
  if (normalized.startsWith('/')) return handleDirectSlashCommand(normalized);
  if (['menu', '主選單', '選單', '開始', 'start'].includes(normalized)) return menuReply('main', source, tenant);
  if (['help', '說明', '幫助'].includes(normalized)) return helpReply(source, tenant);
  if (['今日任務', '今日簡報', 'brief'].includes(normalized)) return menuReply('brief', source, tenant);
  if (['搜尋資料', '搜尋患者', 'search'].includes(normalized)) return menuReply('search', source, tenant);
  if (['上傳/轉文字', '轉文字', '音檔', 'audio'].includes(normalized)) return menuReply('audio', source, tenant);
  if (['ai 助理', 'ai助手', 'ai助理', 'assistant'].includes(normalized)) return menuReply('ai', source, tenant);
  if (['翻譯', 'translation', 'translate'].includes(normalized)) return menuReply('translate', source, tenant);
  return undefined;
}

function menuReply(menu: string, source?: LineSource, tenant = getTenantConfig()): BotReply {
  if (menu === 'help') return helpReply(source, tenant);
  if (menu === 'settings') return settingsMenuReply(source, tenant);
  if (source?.type === 'group' && menu !== 'translate') return helpReply(source, tenant);
  if (source?.type === 'group' && menu === 'translate') return { text: `群組翻譯設定\n\n輸入：\n/set en tw ja\n\n查看代碼：/languages`, buttons: [] };
  if (menu === 'brief') return { text: 'Current step: Daily brief\n\n這裡會顯示 tenant 設定的今日任務、提醒或客戶關係簡報。', buttons: mainMenuButtons() };
  if (menu === 'search') return { text: 'Current step: Search\n\n搜尋工具尚未接上。下一步會由 tenant tools 定義可搜尋的客戶、患者、訂單或案件。', buttons: mainMenuButtons() };
  if (menu === 'audio') return { text: 'Current step: Audio transcript\n\n請直接傳語音、音檔或錄音檔。Bot 會詢問是否轉文字，再讓你選擇語言。', buttons: mainMenuButtons() };
  if (menu === 'ai') return { text: 'Current step: AI assistant\n\n你可以直接輸入問題。未來每個 tenant 可以設定自己的工具、prompt 和工作流程。', buttons: mainMenuButtons() };
  if (menu === 'translate') return { text: `群組翻譯設定\n\n可以用下方按鈕看常用語言組合。`, buttons: languageSetupButtons() };
  return { text: '主選單\n\n請選擇要做的事。', buttons: mainMenuButtons() };
}

type TranslationCommand = { name: 'help' | 'menu' | 'settings' | 'set' | 'on' | 'off' | 'status' | 'languages' | 'summary' | 'actions' | 'catchup'; args: string[] };

function parseTranslationCommand(text: string): TranslationCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const [rawName = '', ...args] = trimmed.slice(1).split(/\s+/);
  const name = rawName.toLowerCase();
  if (name === 'help' || name === 'menu' || name === 'settings' || name === 'set' || name === 'on' || name === 'off' || name === 'status' || name === 'summary' || name === 'actions' || name === 'catchup') return { name, args };
  if (name === 'lang' || name === 'langs' || name === 'languages') return { name: 'languages', args };
  return undefined;
}

function isLikelyCommand(text: string) {
  return text.trim().startsWith('/');
}

function countBillableCharacters(text: string, targetLanguageCount: number) {
  return Array.from(text.trim()).length * Math.max(1, targetLanguageCount);
}

function formatTranslationReply(translations: Array<{ language: string; text: string }>) {
  return translations.map((item) => item.text.trim()).filter(Boolean).join('\n\n').slice(0, 3800);
}

function normalizeForCompare(text: string) {
  return text.replace(/\s+/g, '').toLowerCase();
}

function parseSummaryLimit(value: string | undefined) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(80, Math.max(5, Math.round(parsed)));
}

function formatSummaryReply(summary: GroupSummary, messageCount: number) {
  const sections = [`Summary (${messageCount} messages)`];
  sections.push('Key points');
  sections.push(summary.keyPoints.length ? summary.keyPoints.map((point) => `- ${point}`).join('\n') : '- No clear key points yet.');
  sections.push('Action items');
  sections.push(summary.actionItems.length
    ? summary.actionItems.map((item) => `- ${item.owner ? `${item.owner}: ` : ''}${item.task}${item.due ? ` (due: ${item.due})` : ''}`).join('\n')
    : '- No clear action items.');
  if (summary.openQuestions.length) {
    sections.push('Open questions');
    sections.push(summary.openQuestions.map((question) => `- ${question}`).join('\n'));
  }
  return sections.join('\n\n').slice(0, 3800);
}

function formatActionsReply(actions: GroupActions, messageCount: number) {
  const sections = [`Actions (${messageCount} messages)`];
  sections.push('Action items');
  sections.push(actions.actionItems.length
    ? actions.actionItems.map((item) => {
        const owner = item.owner ? `${item.owner}: ` : '';
        const due = item.due ? ` (due: ${item.due})` : '';
        const status = item.status ? ` [${item.status}]` : '';
        return `- ${owner}${item.task}${due}${status}`;
      }).join('\n')
    : '- No clear action items.');
  if (actions.blockers.length) {
    sections.push('Blockers');
    sections.push(actions.blockers.map((blocker) => `- ${blocker}`).join('\n'));
  }
  if (actions.openQuestions.length) {
    sections.push('Open questions');
    sections.push(actions.openQuestions.map((question) => `- ${question}`).join('\n'));
  }
  return sections.join('\n\n').slice(0, 3800);
}

function formatCatchupReply(catchup: GroupCatchup, messageCount: number) {
  const sections = [`Catchup (${messageCount} messages)`];
  if (catchup.shortSummary) sections.push(catchup.shortSummary);
  sections.push('Key updates');
  sections.push(catchup.keyUpdates.length ? catchup.keyUpdates.map((item) => `- ${item}`).join('\n') : '- No major updates.');
  if (catchup.decisions.length) {
    sections.push('Decisions');
    sections.push(catchup.decisions.map((decision) => `- ${decision}`).join('\n'));
  }
  if (catchup.nextSteps.length) {
    sections.push('Next steps');
    sections.push(catchup.nextSteps.map((step) => `- ${step}`).join('\n'));
  }
  return sections.join('\n\n').slice(0, 3800);
}

function normalizeMention(text: string, source: LineSource | undefined, session: ReturnType<typeof getSession>, names: string[]) {
  const trimmed = text.trim();
  if (!source || source.type === 'user') return { shouldReply: true, text: trimmed };
  const pattern = new RegExp(`@?(${names.map(escapeRegExp).join('|')})`, 'i');
  if (pattern.test(trimmed)) return { shouldReply: true, text: trimmed.replace(pattern, '').trim() };
  if (isSessionActive(session)) return { shouldReply: true, text: trimmed };
  return { shouldReply: false, text: trimmed };
}

function parsePostback(data: string) {
  if (data.includes('=')) {
    const params = new URLSearchParams(data);
    return { action: params.get('action') ?? '', value: params.get('menu') ?? params.get('value') ?? '' };
  }
  const [action = '', ...parts] = data.split(':');
  return { action, value: parts.join(':') };
}

function isClosePhrase(text: string) {
  return /^(謝謝|感謝|ok|okay|好了|不用了|先這樣|結束|沒事了|that's all|thanks)$/i.test(text.trim());
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
