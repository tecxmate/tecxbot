import type { ConversationSession } from './sessionStore.js';
import type { BotReply, TenantConfig } from './types.js';

export async function routeFreeTextWithLlm(input: { tenant: TenantConfig; session: ConversationSession; text: string }): Promise<BotReply | undefined> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;
  const recent = input.session.messages.slice(-10).map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`).join('\n');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, messages: [
      { role: 'system', content: `You are a chat automation assistant for ${input.tenant.name}.\n\nBusiness context:\n${input.tenant.domainContext}\n\nBe concise. Do not pretend data was saved. If a deterministic workflow is needed but unavailable, explain the available action.` },
      { role: 'user', content: `Recent messages:\n${recent || '(none)'}\n\nLatest user message:\n${input.text}` },
    ] }),
  });
  if (!response.ok) {
    console.error('[llm-router] Failed:', response.status, await response.text());
    return undefined;
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  const text = data.choices?.[0]?.message?.content?.trim();
  return text ? { text } : undefined;
}
