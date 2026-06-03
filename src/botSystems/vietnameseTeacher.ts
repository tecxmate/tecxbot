import { appendMessage, getSession } from '../core/sessionStore.js';
import { askVietnameseTeacher, type VietnameseTeacherConfig } from '../core/vietnameseTeacher.js';
import type { BotReply } from '../core/types.js';
import type { LineEvent, LineMentionee, LineMessage, LineSource } from '../platforms/line/types.js';
import type { LineWebhookRuntime } from '../platforms/line/webhook.js';

export async function handleVietnameseTeacherLineEvent(event: LineEvent, runtime: LineWebhookRuntime): Promise<BotReply | undefined> {
  const config = runtime.channel.botSystem.kind === 'vietnamese_teacher' ? runtime.channel.botSystem : undefined;
  if (!config) return undefined;
  const source = event.source;

  if (event.type === 'follow' || event.type === 'join') return welcomeReply(source, config);
  if (event.type !== 'message' || !('message' in event)) return undefined;

  const message = event.message;
  if (message.type !== 'text') {
    if (isGroupLike(source)) return undefined;
    return { text: nudgeText(config), buttons: starterButtons() };
  }

  const mention = normalizeMention(message, source, runtime.tenant.botMentionNames);
  if (!mention.shouldReply) return undefined;
  const text = mention.text.trim();
  if (!text) return welcomeReply(source, config);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { text: 'OPENAI_API_KEY is not configured, so I cannot answer yet.', buttons: isGroupLike(source) ? [] : [] };

  const session = getSession({
    tenantId: runtime.tenant.id,
    platform: 'line',
    sourceType: source?.type ?? 'user',
    sourceId: source?.groupId ?? source?.roomId ?? source?.userId ?? 'unknown',
    userId: source?.userId,
  });
  appendMessage(session, 'user', text);

  try {
    const history = session.messages.slice(0, -1).map((entry) => ({ role: entry.role, text: entry.text }));
    const answer = await askVietnameseTeacher({ apiKey, config, question: text, history, context: isGroupLike(source) ? 'group' : 'direct' });
    const reply = answer || 'I had trouble forming an answer. Could you rephrase your Vietnamese question?';
    appendMessage(session, 'assistant', reply);
    return { text: reply.slice(0, 4800), buttons: isGroupLike(source) ? [] : starterButtons() };
  } catch (error) {
    console.error('[vn-teacher] failed:', error);
    return { text: `Sorry, I could not answer right now: ${formatError(error)}`, buttons: [] };
  }
}

function welcomeReply(source: LineSource | undefined, config: VietnameseTeacherConfig): BotReply {
  if (isGroupLike(source)) {
    return {
      text: `${config.appName} Vietnamese teacher is here. 🇻🇳\n\nMention me with a question and I'll help, e.g.\n@teacher how do I say thank you in Vietnamese?`,
      buttons: [],
    };
  }
  const tagline = config.appTagline ? `\n\n${config.appTagline}` : '';
  const link = config.appUrl ? `\n\n📲 ${config.appUrl}` : '';
  return {
    text: `Xin chào! 👋 Welcome to ${config.appName}.${tagline}\n\nI'm your Vietnamese teacher. Ask me anything about Vietnamese — vocabulary, grammar, pronunciation, or tones. Write in English or 中文 and I'll reply in your language with Vietnamese examples.\n\nTry: "How do I say hello?"${link}`,
    buttons: starterButtons(),
  };
}

function nudgeText(config: VietnameseTeacherConfig): BotReply['text'] {
  return `I'm your Vietnamese teacher from ${config.appName}. Send me a question in English or 中文 and I'll help you learn Vietnamese.`;
}

function starterButtons(): BotReply['buttons'] {
  return [
    [{ label: 'Say hello', text: 'How do I say hello in Vietnamese?' }, { label: 'Numbers 1-10', text: 'Teach me Vietnamese numbers 1 to 10' }],
    [{ label: 'About the app', text: 'What is this app?' }],
  ];
}

function isGroupLike(source: LineSource | undefined) {
  return source?.type === 'group' || source?.type === 'room';
}

// In 1:1 chats always reply. In groups, reply only when the bot is mentioned —
// either via LINE's mention metadata or an @name match in the text.
function normalizeMention(message: Extract<LineMessage, { type: 'text' }>, source: LineSource | undefined, names: string[]) {
  const trimmed = message.text.trim();
  if (!isGroupLike(source)) return { shouldReply: true, text: trimmed };

  const strippedByMetadata = stripSelfMentions(message.text, message.mention?.mentionees);
  if (strippedByMetadata !== undefined) return { shouldReply: true, text: strippedByMetadata };

  const escapedNames = names.map((name) => name.trim()).filter(Boolean).map(escapeRegExp);
  if (!escapedNames.length) return { shouldReply: false, text: trimmed };
  const mentionPattern = new RegExp(`(^|\\s)@(?:${escapedNames.join('|')})(?=$|\\s|[,:;，：])`, 'i');
  if (!mentionPattern.test(message.text)) return { shouldReply: false, text: trimmed };
  const replacePattern = new RegExp(`(^|\\s)@(?:${escapedNames.join('|')})(?=$|\\s|[,:;，：])`, 'ig');
  return { shouldReply: true, text: message.text.replace(replacePattern, ' ').replace(/\s+/g, ' ').trim() };
}

function stripSelfMentions(text: string, mentionees: LineMentionee[] | undefined) {
  const selfMentions = Array.isArray(mentionees)
    ? mentionees.filter((mention) => mention.isSelf === true && Number.isInteger(mention.index) && Number.isInteger(mention.length))
    : [];
  if (!selfMentions.length) return undefined;
  let output = text;
  for (const mention of [...selfMentions].sort((a, b) => b.index - a.index)) {
    output = `${output.slice(0, mention.index)} ${output.slice(mention.index + mention.length)}`;
  }
  return output.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
