import type { GroupContextMessage } from './groupTranslationStore.js';
import type { TenantConfig } from './types.js';

export type GroupSummary = {
  keyPoints: string[];
  actionItems: Array<{ owner?: string; task: string; due?: string }>;
  openQuestions: string[];
};

export type GroupActions = {
  actionItems: Array<{ owner?: string; task: string; due?: string; status?: string }>;
  blockers: string[];
  openQuestions: string[];
};

export type GroupCatchup = {
  shortSummary: string;
  keyUpdates: string[];
  decisions: string[];
  nextSteps: string[];
};

export async function summarizeGroupMessages(input: { apiKey: string; tenant: TenantConfig; messages: GroupContextMessage[]; limit: number }) {
  const content = await runGroupAnalysis({
    apiKey: input.apiKey,
    tenant: input.tenant,
    messages: input.messages,
    limit: input.limit,
    systemPrompt: `You summarize multilingual LINE group chats for ${input.tenant.name}.

Use the messages exactly as context. Be concise and practical.
Return JSON only:
{"keyPoints":["..."],"actionItems":[{"owner":"...","task":"...","due":"..."}],"openQuestions":["..."]}

Rules:
- Include only points supported by the chat.
- Preserve names, dates, deadlines, and commitments.
- If owner or due date is unknown, omit that field.
- Use the dominant language of the chat; if mixed, prefer Traditional Chinese with original names/terms preserved.
- Keep each bullet short.`,
  });
  return parseSummaryJson(content || '{}');
}

export async function extractGroupActions(input: { apiKey: string; tenant: TenantConfig; messages: GroupContextMessage[]; limit: number }) {
  const content = await runGroupAnalysis({
    apiKey: input.apiKey,
    tenant: input.tenant,
    messages: input.messages,
    limit: input.limit,
    systemPrompt: `You extract action items from multilingual LINE group chats for ${input.tenant.name}.

Focus only on commitments, requests, blockers, and unanswered follow-ups.
Return JSON only:
{"actionItems":[{"owner":"...","task":"...","due":"...","status":"..."}],"blockers":["..."],"openQuestions":["..."]}

Rules:
- Do not invent tasks.
- Include owner only when the chat clearly implies one.
- Include due only when a date/time/deadline is present.
- Status can be todo, waiting, blocked, or done when clear.
- Use the dominant language of the chat; if mixed, prefer Traditional Chinese with original names/terms preserved.
- Keep each item short.`,
  });
  return parseActionsJson(content || '{}');
}

export async function catchUpGroupMessages(input: { apiKey: string; tenant: TenantConfig; messages: GroupContextMessage[]; limit: number }) {
  const content = await runGroupAnalysis({
    apiKey: input.apiKey,
    tenant: input.tenant,
    messages: input.messages,
    limit: input.limit,
    systemPrompt: `You write concise catch-up notes for someone who missed a multilingual LINE group chat for ${input.tenant.name}.

Return JSON only:
{"shortSummary":"...","keyUpdates":["..."],"decisions":["..."],"nextSteps":["..."]}

Rules:
- Explain what changed or matters now.
- Include decisions only when the group clearly decided something.
- Include next steps only when the chat supports them.
- Use the dominant language of the chat; if mixed, prefer Traditional Chinese with original names/terms preserved.
- Keep it concise and easy to scan.`,
  });
  return parseCatchupJson(content || '{}');
}

async function runGroupAnalysis(input: { apiKey: string; tenant: TenantConfig; messages: GroupContextMessage[]; limit: number; systemPrompt: string }) {
  const messages = input.messages.slice(-input.limit);
  const transcript = messages.map((message, index) => {
    const speaker = message.userId ? `user:${message.userId}` : 'unknown';
    return `${index + 1}. [${speaker}] ${message.text}`;
  }).join('\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_SUMMARY_MODEL || process.env.OPENAI_TRANSLATION_MODEL || 'gpt-4o-mini',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: `Messages:\n${transcript || '(none)'}` },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI group analysis failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  return data.choices?.[0]?.message?.content;
}

function parseSummaryJson(content: string): GroupSummary {
  const parsed = JSON.parse(content) as Partial<GroupSummary>;
  return {
    keyPoints: toStringArray(parsed.keyPoints).slice(0, 6),
    actionItems: Array.isArray(parsed.actionItems)
      ? parsed.actionItems
          .filter((item): item is { owner?: string; task: string; due?: string } => Boolean(item) && typeof item === 'object' && typeof item.task === 'string')
          .slice(0, 6)
      : [],
    openQuestions: toStringArray(parsed.openQuestions).slice(0, 5),
  };
}

function parseActionsJson(content: string): GroupActions {
  const parsed = JSON.parse(content) as Partial<GroupActions>;
  return {
    actionItems: Array.isArray(parsed.actionItems)
      ? parsed.actionItems
          .filter((item): item is { owner?: string; task: string; due?: string; status?: string } => Boolean(item) && typeof item === 'object' && typeof item.task === 'string')
          .slice(0, 8)
      : [],
    blockers: toStringArray(parsed.blockers).slice(0, 5),
    openQuestions: toStringArray(parsed.openQuestions).slice(0, 5),
  };
}

function parseCatchupJson(content: string): GroupCatchup {
  const parsed = JSON.parse(content) as Partial<GroupCatchup>;
  return {
    shortSummary: typeof parsed.shortSummary === 'string' ? parsed.shortSummary : '',
    keyUpdates: toStringArray(parsed.keyUpdates).slice(0, 6),
    decisions: toStringArray(parsed.decisions).slice(0, 5),
    nextSteps: toStringArray(parsed.nextSteps).slice(0, 5),
  };
}

function toStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}
