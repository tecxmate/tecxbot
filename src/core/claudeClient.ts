// Minimal Anthropic Messages API client (plain fetch, no SDK — consistent with
// the rest of the repo). Used by the Claude assistant bot mode to answer with
// the captured client-conversation context.

export type ClaudeMessage = { role: 'user' | 'assistant'; content: string };

export type ClaudeCallOptions = {
  system?: string;
  messages: ClaudeMessage[];
  maxTokens?: number;
  temperature?: number;
  model?: string;
  apiKey?: string;
};

export function isClaudeConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export function defaultClaudeModel() {
  return process.env.ANTHROPIC_MODEL || process.env.CLAUDE_DAILY_MODEL || 'claude-3-5-sonnet-latest';
}

export async function callClaude(options: ClaudeCallOptions): Promise<string> {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model ?? defaultClaudeModel(),
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.2,
      system: options.system,
      messages: options.messages,
    }),
  });
  if (!response.ok) throw new Error(`Claude request failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.filter((part) => part.type === 'text').map((part) => part.text).filter(Boolean).join('\n\n').trim();
  if (!text) throw new Error('Claude returned an empty response');
  return text;
}
