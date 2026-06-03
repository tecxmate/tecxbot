import { appendGroupContextMessage, getGroupTranslationSettings, setGroupTranslationLanguages, type GroupContextMessage } from '../core/groupTranslationStore.js';
import { getOpsConfig } from '../ops/config.js';
import { createLinearIssue, getLinearIssueByIdentifier, listLinearIssuesByStateName, moveLinearIssueToType, reviseLinearIssue } from '../ops/linear.js';
import { pushLineMessage } from '../platforms/line/client.js';
import type { BotReply, TenantConfig } from '../core/types.js';
import type { LineEvent, LineMessage, LineSource } from '../platforms/line/types.js';
import type { LineWebhookRuntime } from '../platforms/line/webhook.js';

type TecxmateBot = Extract<TenantConfig['botSystem'], { kind: 'tecxmate' }>;

const DEFAULT_CONTEXT_LIMIT = 20;
const MAX_CONTEXT_LIMIT = 60;

// The tecxmate bot fronts client LINE groups AND a 1:1 "operator" chat with the
// owner. Design goal: a guided, tappable assistant a non-technical owner can use
// by tapping buttons — it never creates a task or sends to a client without a
// clear tap. In a group, tagging the bot is the explicit "make a task" signal.
// In 1:1, plain chat is interpreted (greeting → menu; a request → confirm first).
export async function handleTecxmateLineEvent(event: LineEvent, runtime: LineWebhookRuntime): Promise<BotReply | undefined> {
  const botSystem = runtime.channel.botSystem.kind === 'tecxmate' ? runtime.channel.botSystem : undefined;
  if (!botSystem) return undefined;
  const source = event.source;

  if (event.type === 'follow' || event.type === 'join') return welcomeReply(botSystem);
  if (event.type === 'postback' && 'postback' in event) return handlePostback(event.postback?.data ?? '', source, runtime, botSystem);
  if (event.type !== 'message' || !('message' in event) || event.message.type !== 'text') return undefined;

  const groupId = source?.groupId ?? source?.roomId;
  const rawText = event.message.text ?? '';
  const mention = normalizeMention(event.message, source, runtime.tenant.botMentionNames);
  if (!mention.shouldReply) {
    if (groupId && rawText.trim()) appendContext(runtime.tenant.id, groupId, { userId: source?.userId, text: rawText });
    return undefined;
  }

  const text = mention.text.trim();

  // Commands — work everywhere, typed or tapped.
  if (!text || /^(menu|home|start)$/i.test(text)) return menuReply(botSystem);
  if (/^(help|說明|\?)$/i.test(text)) return helpReply(botSystem);
  if (/^(status|whoami)$/i.test(text)) return statusReply(source, botSystem);

  const owner = isOwner(source, botSystem);
  const approval = parseApprovalCommand(text);
  if (approval) return owner ? handleApproval(approval, runtime) : notOwnerReply();

  if (!owner) return notOwnerReply();

  // Only an explicit "task: …" creates directly. Otherwise — whether tagged in a
  // group or messaged in 1:1 — interpret the message and confirm before creating,
  // so a casual "hey" never becomes a task.
  const explicit = /^task[:\s]/i.test(text);
  if (explicit) return dispatchTask(text, source, groupId, runtime);

  if (isGreeting(text)) return greetingReply(botSystem);
  return interpretAndReply(text, source, runtime, botSystem); // NL intent → propose a tappable action, confirm before acting
}

// ---- tappable buttons (postback) ----

async function handlePostback(data: string, source: LineSource | undefined, runtime: LineWebhookRuntime, botSystem: TecxmateBot): Promise<BotReply | undefined> {
  const d = data.startsWith('tm:') ? data.slice(3) : data;
  if (d === 'help') return helpReply(botSystem);
  if (d === 'status') return statusReply(source, botSystem);
  if (d === 'menu') return menuReply(botSystem);
  if (d === 'cancel') return { text: 'Okay — nothing was done.', buttons: menuButtons() };

  const owner = isOwner(source, botSystem);
  if (!owner) return notOwnerReply();
  if (d === 'pending') return handleApproval({ action: 'pending' }, runtime);
  if (d === 'new') return newTaskPromptReply();
  if (d.startsWith('mk:')) return dispatchTask(d.slice(3), source, source?.groupId ?? source?.roomId, runtime);
  if (d.startsWith('approve:')) return handleApproval({ action: 'approve', id: d.slice('approve:'.length) }, runtime);
  if (d.startsWith('send:')) return handleApproval({ action: 'send', id: d.slice('send:'.length) }, runtime);
  if (d.startsWith('discard:')) return handleApproval({ action: 'discard', id: d.slice('discard:'.length) }, runtime);
  if (d.startsWith('revise:')) { const id = d.slice('revise:'.length); return { text: `What should change on ${id}?\nReply:  revise ${id} <your changes>`, buttons: menuButtons() }; }
  if (d.startsWith('end:')) { const id = d.slice('end:'.length); return { text: `End ${id} without sending?`, buttons: [[{ label: '🛑 Yes, end', data: `tm:enddo:${id}` }, { label: '✖️ No', data: 'tm:cancel' }]] }; }
  if (d.startsWith('enddo:')) return handleApproval({ action: 'end', id: d.slice('enddo:'.length) }, runtime);
  return menuReply(botSystem);
}

// ---- approvals ----

type ApprovalCommand = { action: 'approve' | 'send' | 'discard' | 'end' | 'revise' | 'pending'; id?: string; feedback?: string };

// "approve" shows a confirm; the actual client send only happens on "send"
// (a Yes-tap or the explicit confirm button) — so a stray tap never sends.
// "revise <id> <feedback>" sends the draft back for changes; "end <id>" closes it.
function parseApprovalCommand(text: string): ApprovalCommand | undefined {
  const revise = text.match(/^(revise|changes?|edit)\s+([A-Za-z]+-\d+)\b[:\s]*(.*)$/is);
  if (revise) return { action: 'revise', id: revise[2].toUpperCase(), feedback: revise[3].trim() };
  const match = text.match(/^(approve|send|discard|reject|cancel|end|close)\s+([A-Za-z]+-\d+)\b/i);
  if (match) {
    const verb = match[1].toLowerCase();
    const action = verb === 'end' || verb === 'close' ? 'end'
      : verb === 'discard' || verb === 'reject' || verb === 'cancel' ? 'discard'
      : verb === 'send' ? 'send' : 'approve';
    return { action, id: match[2].toUpperCase() };
  }
  if (/^(pending|queue|review|drafts)$/i.test(text)) return { action: 'pending' };
  return undefined;
}

async function handleApproval(cmd: ApprovalCommand, runtime: LineWebhookRuntime): Promise<BotReply> {
  const config = getOpsConfig();
  if (!config.linearApiKey || !config.linearTeamId) return { text: 'Linear is not connected yet.', buttons: menuButtons() };

  if (cmd.action === 'pending') {
    const items = await listLinearIssuesByStateName(config.linearApiKey, config.linearTeamId, 'In Review');
    if (!items.length) return { text: 'Nothing is waiting for your approval right now. 👍', buttons: menuButtons() };
    const buttons = items.slice(0, 6).map((item) => [{ label: `✅ ${item.identifier}`, data: `tm:approve:${item.identifier}` }]);
    return {
      text: ['These drafts are ready for you:', '', ...items.map((item) => `• ${item.identifier} — ${item.title.slice(0, 50)}`), '', 'Tap one to review and send.'].join('\n'),
      buttons,
    };
  }

  const issue = await getLinearIssueByIdentifier(config.linearApiKey, config.linearTeamId, cmd.id!);
  if (!issue) return { text: `I couldn't find ${cmd.id}.`, buttons: menuButtons() };
  // Never act on tasks the bot didn't create (the team may hold human work).
  if (!/source:\s*tecxmate-bot/i.test(issue.description)) return { text: `${issue.identifier} isn't one of my tasks.`, buttons: menuButtons() };

  if (cmd.action === 'discard' || cmd.action === 'end') {
    await moveLinearIssueToType(config.linearApiKey, config.linearTeamId, issue.id, 'canceled');
    return { text: `🛑 Ended ${issue.identifier} — closed, nothing was sent.`, buttons: menuButtons() };
  }

  if (cmd.action === 'revise') {
    const feedback = cmd.feedback?.trim();
    if (!feedback) return { text: `What should change on ${issue.identifier}? Reply:\nrevise ${issue.identifier} <your changes>`, buttons: menuButtons() };
    await reviseLinearIssue(config.linearApiKey, config.linearTeamId, issue.id, `${issue.description}\n\n## Revision requested\n${feedback}`);
    return { text: `✏️ Got it — sending ${issue.identifier} back for changes:\n“${feedback.slice(0, 140)}”\n\nI'll redraft and send you a new version to review.`, buttons: menuButtons() };
  }

  const replyTarget = parseStagedMeta(issue.description, 'reply_target');
  // Pick the most recent staged attachment (revisions append new ones).
  const docUrl = [...issue.attachments].reverse().find((attachment) => /staged|doc|draft/i.test(attachment.title ?? ''))?.url ?? issue.attachments[issue.attachments.length - 1]?.url;
  if (!replyTarget || !docUrl) return { text: `${issue.identifier} isn't ready yet — it may still be drafting.`, buttons: menuButtons() };

  // "approve" = show a confirm; only "send" actually delivers to the client.
  if (cmd.action === 'approve') {
    return {
      text: `Send this to the client now?\n\n${issue.identifier} — ${issue.title.slice(0, 60)}`,
      buttons: [[{ label: '✅ Yes, send it', data: `tm:send:${issue.identifier}` }, { label: '📄 Open doc', url: docUrl }], [{ label: '✖️ Not now', data: 'tm:cancel' }]],
    };
  }

  const token = runtime.channel.line?.channelAccessToken;
  if (!token) return { text: 'LINE channel token is not configured.' };
  await pushLineMessage(replyTarget, { text: `Your document is ready:\n${docUrl}` }, token);
  await moveLinearIssueToType(config.linearApiKey, config.linearTeamId, issue.id, 'completed');
  return { text: `✅ Sent ${issue.identifier} to the client. All done!`, buttons: menuButtons() };
}

function parseStagedMeta(description: string, key: string): string | undefined {
  const line = description.split('\n').find((entry) => entry.trim().startsWith(`${key}:`));
  return line ? line.slice(line.indexOf(':') + 1).trim() : undefined;
}

// ---- task creation ----

async function dispatchTask(instruction: string, source: LineSource | undefined, groupId: string | undefined, runtime: LineWebhookRuntime): Promise<BotReply> {
  const config = getOpsConfig();
  if (!config.linearApiKey || !config.linearTeamId) return { text: 'Linear is not connected yet.', buttons: menuButtons() };

  const { limit, body } = parseInstruction(instruction);
  if (!body) return offerTaskHintReply();

  const context = groupId ? recentContext(runtime.tenant.id, groupId, limit) : [];
  const title = body.replace(/\s+/g, ' ').slice(0, 120);

  try {
    const issue = await createLinearIssue(config.linearApiKey, {
      teamId: config.linearTeamId,
      title,
      description: buildTaskDescription({ body, context, source, groupId, channelId: runtime.channel.id, tenant: runtime.tenant }),
      assigneeId: config.linearDefaultAssigneeId,
      projectId: config.linearProjectId,
      labelIds: config.linearLabelIds,
    });
    return {
      text: `✅ Got it — I've started on this:\n“${title}”\n\nI'll send it to you privately to review, then share the final version here once you approve.`,
      buttons: menuButtons(),
    };
  } catch (error) {
    return { text: `Sorry — I couldn't create that task. (${formatError(error)})`, buttons: menuButtons() };
  }
}

function buildTaskDescription(input: { body: string; context: GroupContextMessage[]; source: LineSource | undefined; groupId?: string; channelId: string; tenant: TenantConfig }): string {
  const contextLines = input.context.length
    ? input.context.map((message) => `- [${shortId(message.userId)}] ${message.text.replace(/\n+/g, ' ').slice(0, 300)}`)
    : ['- (no recent chat captured)'];
  return [
    '## Instruction',
    input.body,
    '',
    '## Client chat context',
    ...contextLines,
    '',
    '## Dispatch metadata',
    '```',
    'source: tecxmate-bot',
    'channel: line',
    `reply_target: ${input.groupId ?? input.source?.userId ?? 'unknown'}`,
    `line_channel: ${input.channelId}`,
    `tenant: ${input.tenant.id}`,
    `requester: ${input.source?.userId ?? 'unknown'}`,
    '```',
    '',
    '## Completion rule',
    'Produce the document in Drive, then push the share link back to reply_target with /api/tecxmate-push. Do not auto-send to the client without owner confirmation.',
  ].join('\n');
}

function parseInstruction(instruction: string): { limit: number; body: string } {
  let rest = instruction.replace(/^(task|做|do)\s*:?\s*/i, '');
  let limit = DEFAULT_CONTEXT_LIMIT;
  const countMatch = rest.match(/^(\d{1,2})\s+/);
  if (countMatch) {
    limit = Math.min(MAX_CONTEXT_LIMIT, Math.max(1, Number(countMatch[1])));
    rest = rest.slice(countMatch[0].length);
  }
  return { limit, body: rest.trim() };
}

function appendContext(tenantId: string, groupId: string, message: { userId?: string; text: string }) {
  const settings = getGroupTranslationSettings({ tenantId, platform: 'line', groupId })
    ?? setGroupTranslationLanguages({ tenantId, platform: 'line', groupId, languageCodes: [] });
  appendGroupContextMessage(settings, message);
}

function recentContext(tenantId: string, groupId: string, limit: number): GroupContextMessage[] {
  const settings = getGroupTranslationSettings({ tenantId, platform: 'line', groupId });
  return settings ? settings.recentMessages.slice(-limit) : [];
}

function isOwner(source: LineSource | undefined, botSystem: TecxmateBot): boolean {
  if (botSystem.ownerUserIds.length === 0) return true; // personal deployment
  return Boolean(source?.userId && botSystem.ownerUserIds.includes(source.userId));
}

// ---- intent helpers ----

function isGreeting(text: string): boolean {
  return /^(hi|hello|hey|yo|sup|gm|gn|hiya|good\s*(morning|afternoon|evening|night)|thanks?|thank\s*you|thx|ty|ok|okay|k|cool|nice|great|👍|🙏|❤️|hi\s*bot|hey\s*bot)[.!?]*$/i.test(text.trim());
}

// ---- natural-language intent (lightweight LLM router) ----
// The owner can type a sentence; a small model maps it to ONE action and we reply
// with the matching button to tap. The model only ROUTES — every consequential
// action still needs a confirm tap, so a misread can't send or create on its own.
// Its "memory" is the list of pending drafts (so it can resolve "it"/"the contract").
async function interpretAndReply(text: string, source: LineSource | undefined, runtime: LineWebhookRuntime, botSystem: TecxmateBot): Promise<BotReply> {
  const config = getOpsConfig();
  if (!config.openAiApiKey) return offerTaskReply(text); // no LLM → deterministic confirm
  let pending: Array<{ identifier: string; title: string }> = [];
  try {
    if (config.linearApiKey && config.linearTeamId) pending = await listLinearIssuesByStateName(config.linearApiKey, config.linearTeamId, 'In Review');
  } catch { /* best-effort context */ }
  let intent: { action: string; issueId?: string; taskText?: string };
  try {
    intent = await classifyIntent(config.openAiApiKey, text, pending);
  } catch {
    return offerTaskReply(text); // LLM failed → fall back to the safe confirm
  }
  return intentToReply(intent, text, pending, source, runtime, botSystem);
}

async function classifyIntent(apiKey: string, text: string, pending: Array<{ identifier: string; title: string }>): Promise<{ action: string; issueId?: string; taskText?: string }> {
  const pendingList = pending.length ? pending.map((item) => `${item.identifier} — ${item.title.slice(0, 60)}`).join('\n') : 'none';
  const system = [
    'You route ONE LINE message from a business owner to ONE action for an assistant bot.',
    'The bot drafts documents (called "tasks") and, after the owner approves, sends a finished draft to a client.',
    'Reply with JSON only: {"action": "...", "issueId": "...", "taskText": "..."}.',
    '',
    'Actions:',
    '- new_task: owner wants the team to draft/create/edit a document. Put a clear imperative instruction in taskText.',
    '- approve: owner wants to send/approve a finished draft to a client. If a specific draft is referenced, set issueId.',
    '- discard: owner wants to cancel a draft. Set issueId if referenced.',
    '- pending: owner asks what is waiting / to review / pending.',
    '- status: owner asks whether things are working.',
    '- help: owner asks how to use this or what it can do.',
    '- smalltalk: greeting, thanks, or chit-chat.',
    '- unknown: cannot tell.',
    '',
    'Drafts awaiting approval (use to resolve "it" / "the contract" / "the Acme one"):',
    pendingList,
    '',
    'Pick exactly one action. Only use an issueId from the list above. Output JSON only.',
  ].join('\n');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_OPS_MODEL || process.env.OPENAI_TRANSLATION_MODEL || 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: text.slice(0, 1000) }],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI intent failed: ${response.status}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}') as { action?: string; issueId?: string; taskText?: string };
  return { action: String(parsed.action || 'unknown'), issueId: parsed.issueId ? String(parsed.issueId) : undefined, taskText: parsed.taskText ? String(parsed.taskText) : undefined };
}

async function intentToReply(intent: { action: string; issueId?: string; taskText?: string }, originalText: string, pending: Array<{ identifier: string; title: string }>, source: LineSource | undefined, runtime: LineWebhookRuntime, botSystem: TecxmateBot): Promise<BotReply> {
  const resolveId = (raw?: string): string | undefined => {
    const candidate = raw?.toUpperCase().trim();
    if (candidate) {
      const match = pending.find((item) => item.identifier.toUpperCase() === candidate);
      if (match) return match.identifier;
      if (/^[A-Z]+-\d+$/.test(candidate)) return candidate;
    }
    return pending.length === 1 ? pending[0].identifier : undefined;
  };

  switch (intent.action) {
    case 'new_task':
      return offerTaskReply((intent.taskText || originalText).trim());
    case 'approve': {
      const id = resolveId(intent.issueId);
      return id ? handleApproval({ action: 'approve', id }, runtime) : handleApproval({ action: 'pending' }, runtime);
    }
    case 'discard': {
      const id = resolveId(intent.issueId);
      if (id) return { text: `Discard ${id}? It will be cancelled and nothing is sent.`, buttons: [[{ label: '✅ Yes, discard', data: `tm:discard:${id}` }, { label: '✖️ No', data: 'tm:cancel' }]] };
      return handleApproval({ action: 'pending' }, runtime);
    }
    case 'pending':
      return handleApproval({ action: 'pending' }, runtime);
    case 'status':
      return statusReply(source, botSystem);
    case 'help':
      return helpReply(botSystem);
    case 'smalltalk':
      return greetingReply(botSystem);
    default:
      return { text: 'I wasn\'t quite sure what you meant — here\'s what I can do:', buttons: menuButtons() };
  }
}

// ---- replies ----

function menuButtons(): BotReply['buttons'] {
  return [[
    { label: '➕ New task', data: 'tm:new' },
    { label: '📋 Pending', data: 'tm:pending' },
    { label: 'ℹ️ Status', data: 'tm:status' },
    { label: '❓ Help', data: 'tm:help' },
  ]];
}

function menuReply(botSystem: TecxmateBot): BotReply {
  return { text: `${botSystem.companyName} assistant — what would you like to do?`, buttons: menuButtons() };
}

function greetingReply(botSystem: TecxmateBot): BotReply {
  return { text: `Hi! 👋 I'm your ${botSystem.companyName} assistant. What would you like to do?`, buttons: menuButtons() };
}

function newTaskPromptReply(): BotReply {
  return {
    text: 'Sure — just type what you\'d like the team to do.\n\nFor example:\n“Draft a service contract for Acme and send it to their group.”',
    buttons: menuButtons(),
  };
}

function offerTaskReply(text: string): BotReply {
  const body = text.slice(0, 240);
  return {
    text: `Would you like me to make this a task for the team?\n\n“${text.slice(0, 300)}”`,
    buttons: [[{ label: '✅ Yes, create task', data: `tm:mk:${body}` }, { label: '✖️ No', data: 'tm:cancel' }]],
  };
}

function offerTaskHintReply(): BotReply {
  return { text: 'Tell me what you\'d like done — for example:\n“Draft an invoice for Acme.”', buttons: menuButtons() };
}

function notOwnerReply(): BotReply {
  return { text: 'Only the account owner can manage tasks here.', buttons: [] };
}

function welcomeReply(botSystem: TecxmateBot): BotReply {
  return {
    text: `Hi! 👋 I'm the ${botSystem.companyName} assistant.\n\nIn a client group, tag me to turn the chat into a task. Here in our 1:1 chat, just tell me what you need — or tap a button below.`,
    buttons: menuButtons(),
  };
}

function helpReply(botSystem: TecxmateBot): BotReply {
  return {
    text: [
      `${botSystem.companyName} assistant — how it works`,
      '',
      '• In a client group: tag me with what you need,',
      '  e.g. “@tecxmate draft a contract and send it here”.',
      '• Here in 1:1: just tell me, or tap ➕ New task.',
      '• When a draft is ready I message you — tap ✅ Approve to send it.',
      '',
      'Tap 📋 Pending anytime to see drafts waiting for you.',
    ].join('\n'),
    buttons: menuButtons(),
  };
}

function statusReply(source: LineSource | undefined, botSystem: TecxmateBot): BotReply {
  const config = getOpsConfig();
  return {
    text: [
      `${botSystem.companyName} assistant`,
      `Connected: ${config.linearApiKey && config.linearTeamId ? 'yes ✅' : 'not yet'}`,
      source?.userId ? `Your LINE id: ${source.userId}` : 'No LINE id in this event.',
    ].join('\n'),
    buttons: menuButtons(),
  };
}

function shortId(userId?: string) {
  if (!userId) return 'client';
  return userId.length > 8 ? `${userId.slice(0, 6)}…` : userId;
}

function normalizeMention(message: LineMessage, source: LineSource | undefined, names: string[]) {
  const text = message.type === 'text' ? message.text.trim() : '';
  if (!source || source.type === 'user') return { shouldReply: true, text };
  // In a group, only respond to a REAL @-mention of this bot (LINE marks it
  // isSelf) — never to a message that merely contains a word like "bot".
  if (message.type === 'text' && message.mention?.mentionees?.some((mentionee) => mentionee.isSelf)) {
    return { shouldReply: true, text: stripMentionNames(text, names) };
  }
  // Fallback only when the message STARTS with the bot's name (typed, no picker).
  const startPattern = new RegExp(`^\\s*@?(${names.map(escapeRegExp).join('|')})\\b[\\s,:，、]*`, 'i');
  if (startPattern.test(text)) return { shouldReply: true, text: text.replace(startPattern, '').trim() };
  return { shouldReply: false, text };
}

function stripMentionNames(text: string, names: string[]) {
  return text.replace(mentionPattern(names), ' ').replace(/\s+/g, ' ').trim();
}

function mentionPattern(names: string[]) {
  return new RegExp(`@?(${names.map(escapeRegExp).join('|')})`, 'ig');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
