import { appendGroupContextMessage, getGroupTranslationSettings, setGroupTranslationLanguages, type GroupContextMessage } from '../core/groupTranslationStore.js';
import { getOpsConfig } from '../ops/config.js';
import { createLinearIssue, getLinearIssueByIdentifier, listLinearIssuesByStateName, moveLinearIssueToType } from '../ops/linear.js';
import { pushLineMessage } from '../platforms/line/client.js';
import type { BotReply, TenantConfig } from '../core/types.js';
import type { LineEvent, LineMessage, LineSource } from '../platforms/line/types.js';
import type { LineWebhookRuntime } from '../platforms/line/webhook.js';

const DEFAULT_CONTEXT_LIMIT = 20;
const MAX_CONTEXT_LIMIT = 60;

// The tecxmate bot fronts client LINE groups. Regular client messages are
// silently kept as rolling context; when the owner tags the bot with an
// instruction, the recent context plus that instruction become a Linear task
// that the local coding agent in tecxcorp picks up and executes.
export async function handleTecxmateLineEvent(event: LineEvent, runtime: LineWebhookRuntime): Promise<BotReply | undefined> {
  const botSystem = runtime.channel.botSystem.kind === 'tecxmate' ? runtime.channel.botSystem : undefined;
  if (!botSystem) return undefined;
  const source = event.source;

  if (event.type === 'follow' || event.type === 'join') return welcomeReply(botSystem.companyName);
  if (event.type !== 'message' || !('message' in event) || event.message.type !== 'text') return undefined;

  const groupId = source?.groupId ?? source?.roomId;
  const rawText = event.message.text ?? '';

  const mention = normalizeMention(event.message, source, runtime.tenant.botMentionNames);
  if (!mention.shouldReply) {
    // Untagged group chatter — keep it as context so a later task has history.
    if (groupId && rawText.trim()) appendContext(runtime.tenant.id, groupId, { userId: source?.userId, text: rawText });
    return undefined;
  }

  const instruction = mention.text.trim();
  if (!instruction || /^(help|menu|start|說明)$/i.test(instruction)) return helpReply(botSystem.companyName);
  if (/^(status|whoami)$/i.test(instruction)) return statusReply(source, botSystem);

  if (!isOwner(source, botSystem)) {
    return { text: 'Only the account owner can dispatch tasks from this bot. Your message was noted but no task was created.' };
  }

  const approval = parseApprovalCommand(instruction);
  if (approval) return handleApproval(approval, runtime);

  return dispatchTask(instruction, source, groupId, runtime);
}

type ApprovalCommand = { action: 'approve' | 'discard' | 'pending'; id?: string };

// Owner approval of a staged draft: "approve TECX-26" sends the staged doc to
// the client and marks it Done; "discard TECX-26" cancels it; "pending" lists
// what is awaiting approval. The tick (on the agent host) stages the doc link as
// a Linear attachment and moves the task to "In Review" — Linear is the store.
function parseApprovalCommand(text: string): ApprovalCommand | undefined {
  const match = text.match(/^(approve|send|discard|reject)\s+([A-Za-z]+-\d+)\b/i);
  if (match) return { action: /^(discard|reject)$/i.test(match[1]) ? 'discard' : 'approve', id: match[2].toUpperCase() };
  if (/^(pending|queue|review)$/i.test(text)) return { action: 'pending' };
  return undefined;
}

async function handleApproval(cmd: ApprovalCommand, runtime: LineWebhookRuntime): Promise<BotReply> {
  const config = getOpsConfig();
  if (!config.linearApiKey || !config.linearTeamId) return { text: 'Linear is not configured.' };

  if (cmd.action === 'pending') {
    const items = await listLinearIssuesByStateName(config.linearApiKey, config.linearTeamId, 'In Review');
    if (!items.length) return { text: 'No drafts pending approval.' };
    return { text: ['Pending approval:', ...items.map((item) => `• ${item.identifier} ${item.title.slice(0, 50)}`), '', 'Reply: approve <id>  or  discard <id>'].join('\n') };
  }

  const issue = await getLinearIssueByIdentifier(config.linearApiKey, config.linearTeamId, cmd.id!);
  if (!issue) return { text: `Task ${cmd.id} not found.` };

  if (cmd.action === 'discard') {
    await moveLinearIssueToType(config.linearApiKey, config.linearTeamId, issue.id, 'canceled');
    return { text: `Discarded ${issue.identifier}. Nothing was sent to the client.` };
  }

  const replyTarget = parseStagedMeta(issue.description, 'reply_target');
  const docUrl = issue.attachments.find((attachment) => /staged|doc|draft/i.test(attachment.title ?? ''))?.url ?? issue.attachments[0]?.url;
  if (!replyTarget || !docUrl) return { text: `${issue.identifier} has no staged document yet — it may still be drafting.` };
  const token = runtime.channel.line?.channelAccessToken;
  if (!token) return { text: 'LINE channel token is not configured.' };

  await pushLineMessage(replyTarget, { text: `Your document is ready:\n${docUrl}` }, token);
  await moveLinearIssueToType(config.linearApiKey, config.linearTeamId, issue.id, 'completed');
  return { text: `✅ Sent ${issue.identifier} to the client and marked it Done.` };
}

function parseStagedMeta(description: string, key: string): string | undefined {
  const line = description.split('\n').find((entry) => entry.trim().startsWith(`${key}:`));
  return line ? line.slice(line.indexOf(':') + 1).trim() : undefined;
}

async function dispatchTask(instruction: string, source: LineSource | undefined, groupId: string | undefined, runtime: LineWebhookRuntime): Promise<BotReply> {
  const config = getOpsConfig();
  if (!config.linearApiKey || !config.linearTeamId) {
    return { text: 'Linear is not configured. Set LINEAR_API_KEY and LINEAR_TEAM_ID to dispatch tasks.' };
  }

  const { limit, body } = parseInstruction(instruction);
  if (!body) return { text: 'Tag me with what you want done.\nExample: @tecxmate update the draft contract with the new price and send it to this group.' };

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
      text: `Task dispatched to the coding agent.\n\n${issue.identifier} ${issue.title}\n${issue.url}\n\nContext captured: ${context.length} recent message${context.length === 1 ? '' : 's'}.`,
    };
  } catch (error) {
    return { text: `Could not create the Linear task: ${formatError(error)}` };
  }
}

function buildTaskDescription(input: { body: string; context: GroupContextMessage[]; source: LineSource | undefined; groupId?: string; channelId: string; tenant: TenantConfig }): string {
  const contextLines = input.context.length
    ? input.context.map((message) => `- [${shortId(message.userId)}] ${message.text.replace(/\n+/g, ' ').slice(0, 300)}`)
    : ['- (no recent chat captured)'];
  // The "Dispatch metadata" block is the contract with the tecxcorp agent: it
  // reads channel + reply_target to push the finished artifact back via
  // /api/tecxmate-push. Keep these keys stable.
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
    `channel: line`,
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
  // Optional leading "task" keyword and an optional message count: "task 30 ..."
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

function isOwner(source: LineSource | undefined, botSystem: Extract<TenantConfig['botSystem'], { kind: 'tecxmate' }>): boolean {
  if (botSystem.ownerUserIds.length === 0) return true; // personal deployment
  return Boolean(source?.userId && botSystem.ownerUserIds.includes(source.userId));
}

function normalizeMention(message: LineMessage, source: LineSource | undefined, names: string[]) {
  const text = message.type === 'text' ? message.text.trim() : '';
  if (!source || source.type === 'user') return { shouldReply: true, text };
  if (message.type === 'text' && message.mention?.mentionees?.some((mentionee) => mentionee.isSelf)) {
    return { shouldReply: true, text: stripMentionNames(text, names) };
  }
  const pattern = mentionPattern(names);
  if (pattern.test(text)) return { shouldReply: true, text: text.replace(pattern, '').trim() };
  return { shouldReply: false, text };
}

function stripMentionNames(text: string, names: string[]) {
  return text.replace(mentionPattern(names), ' ').replace(/\s+/g, ' ').trim();
}

function mentionPattern(names: string[]) {
  return new RegExp(`@?(${names.map(escapeRegExp).join('|')})`, 'ig');
}

function welcomeReply(companyName: string): BotReply {
  return {
    text: `${companyName} assistant is connected.\n\nTag me with an instruction to turn this chat into a task for our team:\n@tecxmate update the contract draft and send it to this group.\n\nType @tecxmate help for more.`,
  };
}

function helpReply(companyName: string): BotReply {
  return {
    text: [
      `${companyName} assistant`,
      '',
      'Tag me with a request and I create a task for the team, using the recent chat as context:',
      '@tecxmate <what you want done>',
      '@tecxmate task 30 <request>  — use the last 30 messages as context',
      '',
      'When a draft is ready I message you. Then reply:',
      'approve <id>  — send the doc to the client',
      'discard <id>  — cancel it',
      'pending       — list drafts awaiting approval',
      '',
      'Status: @tecxmate status',
    ].join('\n'),
  };
}

function statusReply(source: LineSource | undefined, botSystem: Extract<TenantConfig['botSystem'], { kind: 'tecxmate' }>): BotReply {
  const config = getOpsConfig();
  return {
    text: [
      `${botSystem.companyName} assistant status`,
      `Linear: ${config.linearApiKey && config.linearTeamId ? 'configured' : 'not configured'}`,
      `Owner gating: ${botSystem.ownerUserIds.length ? `${botSystem.ownerUserIds.length} allowed id(s)` : 'open (personal deployment)'}`,
      source?.userId ? `Your LINE user id: ${source.userId}` : 'No LINE user id in this event.',
    ].join('\n'),
  };
}

function shortId(userId?: string) {
  if (!userId) return 'client';
  return userId.length > 8 ? `${userId.slice(0, 6)}…` : userId;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
