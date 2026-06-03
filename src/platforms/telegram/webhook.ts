import { signChatToken } from '../../core/telegramLink.js';
import { answerCallbackQuery, downloadTelegramFile, sendTelegramMessage } from './client.js';
import { transcribeAudio, type TranscribeLanguage } from './deepgram.js';
import type { TelegramCallbackQuery, TelegramFile, TelegramMessage, TelegramUpdate } from './types.js';

// Telegram bots can only download files up to 20MB via getFile. Anything
// larger is routed to the web upload page, which streams straight to Deepgram.
const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

const START_TEXT = [
  '🎙️ Speech-to-text bot',
  '',
  '傳語音、音檔或影片給我，我會用 Deepgram 轉成文字。',
  'Send me a voice note, audio, or video file and I will transcribe it with Deepgram.',
  '',
  '大於 20MB 的檔案會給你一個網頁上傳連結。',
  'Files over 20MB get a web upload link.',
].join('\n');

// Remembers the last file each chat sent, so the language buttons know what to
// transcribe. In-memory and best-effort: if the instance recycles between the
// upload and the button tap, we ask the user to resend.
const pendingFiles = new Map<number, string>();

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  if (update.callback_query) return handleCallback(update.callback_query);
  if (update.message) return handleMessage(update.message);
}

async function handleMessage(message: TelegramMessage): Promise<void> {
  const chatId = message.chat.id;
  const file = extractAudioFile(message);

  if (!file) {
    if (message.text?.trim().startsWith('/start')) return sendTelegramMessage(chatId, START_TEXT);
    return sendTelegramMessage(chatId, '請直接傳語音、音檔或影片。\nSend a voice / audio / video file to transcribe.');
  }

  if (file.file_size && file.file_size > TELEGRAM_MAX_DOWNLOAD_BYTES) {
    const url = `${publicBaseUrl()}/upload.html?token=${encodeURIComponent(signChatToken(chatId))}`;
    return sendTelegramMessage(chatId, [
      '這個檔案大於 20MB，Telegram 不允許 bot 直接下載。',
      'This file is over 20MB, which bots cannot download directly.',
      '',
      '請用這個連結上傳，轉好的文字會自動傳回這個對話：',
      'Upload it here and the transcript comes back to this chat:',
      '',
      url,
    ].join('\n'));
  }

  pendingFiles.set(chatId, file.file_id);
  return sendTelegramMessage(chatId, '選擇語言 / Choose language:', [[
    { text: '中文 zh-TW', callback_data: 'tx|zh-TW' },
    { text: 'English', callback_data: 'tx|en' },
    { text: '自動 Auto', callback_data: 'tx|auto' },
  ]]);
}

async function handleCallback(callback: TelegramCallbackQuery): Promise<void> {
  await answerCallbackQuery(callback.id);
  const chatId = callback.message?.chat.id;
  if (!chatId || !callback.data?.startsWith('tx|')) return;
  const language = callback.data.slice(3) as TranscribeLanguage;

  const fileId = pendingFiles.get(chatId);
  if (!fileId) return sendTelegramMessage(chatId, '找不到剛剛的檔案，請重新傳一次。\nFile not found, please resend it.');
  pendingFiles.delete(chatId);

  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return sendTelegramMessage(chatId, 'DEEPGRAM_API_KEY 尚未設定，無法轉錄。');

  await sendTelegramMessage(chatId, '轉錄中… Transcribing…');
  try {
    const media = await downloadTelegramFile(fileId);
    const transcript = await transcribeAudio({ apiKey, audio: media.content, contentType: media.contentType, language });
    await sendTranscript(chatId, transcript);
  } catch (error) {
    await sendTelegramMessage(chatId, `轉錄失敗 Failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function sendTranscript(chatId: number, transcript: string): Promise<void> {
  const text = transcript.trim();
  if (!text) return sendTelegramMessage(chatId, '沒有偵測到語音內容。No speech detected.');
  for (let index = 0; index < text.length; index += 3900) {
    await sendTelegramMessage(chatId, text.slice(index, index + 3900));
  }
}

function extractAudioFile(message: TelegramMessage): TelegramFile | undefined {
  if (message.voice) return message.voice;
  if (message.audio) return message.audio;
  if (message.video) return message.video;
  if (message.video_note) return message.video_note;
  if (message.document && /^(audio|video)\//.test(message.document.mime_type ?? '')) return message.document;
  return undefined;
}

function publicBaseUrl() {
  return (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
}
