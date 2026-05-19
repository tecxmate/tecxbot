import { appendMessage, closeSession, getSession, isSessionActive } from '../../core/sessionStore.js';
import { getTenantConfig } from '../../core/tenantStore.js';
import { routeFreeTextWithLlm } from '../../core/llmRouter.js';
import { polishTranscript, transcribeWithDeepgram } from '../../core/transcription.js';
import type { BotReply, TranscriptLanguage } from '../../core/types.js';
import { downloadLineMessageContent, mainMenuButtons, replyLineMessage } from './client.js';
import type { LineEvent, LineMessage, LineSource, LineWebhookPayload } from './types.js';

export type { LineWebhookPayload };

export async function handleLineWebhook(payload: LineWebhookPayload) {
  let processed = 0;
  for (const event of payload.events ?? []) {
    const replyToken = 'replyToken' in event ? event.replyToken : undefined;
    if (!replyToken) continue;
    const reply = await handleLineEvent(event);
    if (reply) {
      await replyLineMessage(replyToken, reply);
      processed += 1;
    }
  }
  return processed;
}

async function handleLineEvent(event: LineEvent): Promise<BotReply | undefined> {
  const tenant = getTenantConfig();
  const source = event.source;
  const session = getSession({ tenantId: tenant.id, platform: 'line', sourceType: source?.type ?? 'user', sourceId: source?.groupId ?? source?.roomId ?? source?.userId ?? 'unknown', userId: source?.userId });
  if (event.type === 'postback' && 'postback' in event) return handlePostback(event.postback?.data ?? '', session, tenant);
  if (event.type !== 'message') return undefined;
  if (!('message' in event)) return undefined;
  return handleMessage(event.message, source, session, tenant);
}

async function handleMessage(message: LineMessage, source: LineSource | undefined, session: ReturnType<typeof getSession>, tenant: ReturnType<typeof getTenantConfig>) {
  if (message.type === 'text') {
    const mention = normalizeMention(message.text, source, session, tenant.botMentionNames);
    if (!mention.shouldReply) return undefined;
    const text = mention.text.trim();
    if (!text) return undefined;
    appendMessage(session, 'user', text);
    if (isClosePhrase(text)) {
      closeSession(session);
      return { text: '已結束這次對話。需要時可再點下方選單。', buttons: mainMenuButtons() };
    }
    const menu = handleMenuText(text);
    if (menu) {
      appendMessage(session, 'assistant', menu.text);
      return menu;
    }
    const llmReply = await routeFreeTextWithLlm({ tenant, session, text });
    const reply = llmReply ?? { text: '我可以協助文字整理、轉錄音檔，或依照企業設定執行工作流程。', buttons: mainMenuButtons() };
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
  return { text: '目前這個訊息類型尚未支援。', buttons: mainMenuButtons() };
}

async function handlePostback(data: string, session: ReturnType<typeof getSession>, tenant: ReturnType<typeof getTenantConfig>): Promise<BotReply> {
  const parsed = parsePostback(data);
  if (parsed.action === 'menu') return menuReply(parsed.value);
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
  if (parsed.action === 'audio_language') return processAudio(session, tenant, parsed.value === 'en' ? 'en' : 'zh-TW');
  if (parsed.action === 'polish_transcript') {
    if (!session.transcript?.rawText) return { text: '找不到剛剛的 raw transcript，請重新上傳音檔。', buttons: mainMenuButtons() };
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { text: 'OPENAI_API_KEY 尚未設定，無法整理 transcript。', buttons: mainMenuButtons() };
    const polished = await polishTranscript({ apiKey, tenant, rawTranscript: session.transcript.rawText, language: session.transcript.language });
    return { text: `Current step: Polished transcript ready\n\n${polished.slice(0, 1800)}`, buttons: mainMenuButtons() };
  }
  return { text: '收到操作，但目前尚未啟用對應流程。', buttons: mainMenuButtons() };
}

async function processAudio(session: ReturnType<typeof getSession>, tenant: ReturnType<typeof getTenantConfig>, language: TranscriptLanguage): Promise<BotReply> {
  if (!session.audio) return { text: '找不到剛剛的音檔，請重新上傳一次。', buttons: mainMenuButtons() };
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return { text: 'DEEPGRAM_API_KEY 尚未設定，無法轉文字。', buttons: mainMenuButtons() };
  try {
    const media = await downloadLineMessageContent(session.audio.platformMessageId);
    const result = await transcribeWithDeepgram({ apiKey, audio: media.content, contentType: media.contentType, language });
    const rawText = result.transcript.trim();
    session.transcript = { rawText, language, createdAt: Date.now() };
    return { text: `Current step: Raw transcript ready\n\nDeepgram 轉文字完成\n\nlanguage: ${language === 'en' ? 'English' : '繁體中文'}\ncontent_type: ${media.contentType}\nspeakers: ${result.speakers.length || 'unknown'}\n\nRaw transcript preview:\n${rawText ? rawText.slice(0, 2800) : 'Deepgram 沒有回傳可用 transcript。'}`, buttons: [[{ label: '整理 transcript', data: 'polish_transcript:start' }, { label: 'AI 助理', data: 'menu:ai' }]] };
  } catch (error) {
    return { text: `音檔已收到，但處理失敗：${formatError(error)}`, buttons: mainMenuButtons() };
  }
}

function handleMenuText(text: string): BotReply | undefined {
  const normalized = text.trim().toLowerCase();
  if (['menu', '主選單', '選單', '開始', 'start'].includes(normalized)) return menuReply('main');
  if (['今日任務', '今日簡報', 'brief'].includes(normalized)) return menuReply('brief');
  if (['搜尋資料', '搜尋患者', 'search'].includes(normalized)) return menuReply('search');
  if (['上傳/轉文字', '轉文字', '音檔', 'audio'].includes(normalized)) return menuReply('audio');
  if (['ai 助理', 'ai助手', 'ai助理', 'assistant'].includes(normalized)) return menuReply('ai');
  return undefined;
}

function menuReply(menu: string): BotReply {
  if (menu === 'brief') return { text: 'Current step: Daily brief\n\n這裡會顯示 tenant 設定的今日任務、提醒或客戶關係簡報。', buttons: mainMenuButtons() };
  if (menu === 'search') return { text: 'Current step: Search\n\n搜尋工具尚未接上。下一步會由 tenant tools 定義可搜尋的客戶、患者、訂單或案件。', buttons: mainMenuButtons() };
  if (menu === 'audio') return { text: 'Current step: Audio transcript\n\n請直接傳語音、音檔或錄音檔。Bot 會詢問是否轉文字，再讓你選擇語言。', buttons: mainMenuButtons() };
  if (menu === 'ai') return { text: 'Current step: AI assistant\n\n你可以直接輸入問題。未來每個 tenant 可以設定自己的工具、prompt 和工作流程。', buttons: mainMenuButtons() };
  return { text: 'Current step: Main menu\n\n請選擇要做的事。', buttons: mainMenuButtons() };
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
  const [action = '', value = ''] = data.split(':');
  return { action, value };
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
