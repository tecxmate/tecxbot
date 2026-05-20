import { getLanguageLabel } from './languages.js';
import type { TenantConfig } from './types.js';

export type TranslationResult = {
  sourceLanguage: string;
  translations: Array<{ language: string; text: string }>;
  ambiguity?: {
    hasAmbiguity: boolean;
    reason?: string;
    suggestedQuestion?: string;
  };
};

export async function translateGroupMessage(input: { apiKey: string; tenant: TenantConfig; text: string; targetLanguages: string[]; contextMessages?: Array<{ userId?: string; text: string }> }): Promise<TranslationResult> {
  const targetLabels = input.targetLanguages.map((code) => `${code}: ${getLanguageLabel(code)}`).join('\n');
  const context = input.contextMessages?.slice(-12).map((message, index) => `${index + 1}. ${message.userId ? `[${message.userId}] ` : ''}${message.text}`).join('\n') || '(none)';
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_TRANSLATION_MODEL || 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a context-aware group-chat translation engine for ${input.tenant.name}.

Style:
- Translate naturally and conversationally, as a fluent human would in the target language.
- Preserve the speaker's intent, tone, politeness, and level of formality.
- Keep the translation faithful. Do not embellish, summarize, add facts, or answer the message.
- Keep output one-by-one: one translation per requested target language.
- Preserve names, URLs, emojis, numbers, line breaks, and formatting.
- Prefer natural target-language phrasing over word-for-word structure when the meaning is clear.

Context:
- Use recent group messages only to resolve pronouns, omitted subjects, terminology, and references.
- Do not translate prior context. Translate only the latest message.
- If the latest message is ambiguous enough that replying with a clarifying question would help in the future, mark ambiguity metadata. Do not ask the question in the translation text.

Return JSON only with this shape:
{"sourceLanguage":"<BCP-47 code or unknown>","translations":[{"language":"<target code>","text":"<translation>"}],"ambiguity":{"hasAmbiguity":false,"reason":"","suggestedQuestion":""}}`,
        },
        {
          role: 'user',
          content: `Recent group context:
${context}

Target languages:
${targetLabels}

Latest message to translate:
${input.text}`,
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`OpenAI translation failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return { sourceLanguage: 'unknown', translations: [] };
  return parseTranslationJson(content, input.targetLanguages);
}

function parseTranslationJson(content: string, targetLanguages: string[]): TranslationResult {
  const parsed = JSON.parse(content) as Partial<TranslationResult>;
  const translations = Array.isArray(parsed.translations)
    ? parsed.translations
        .filter((item): item is { language: string; text: string } => typeof item?.language === 'string' && typeof item?.text === 'string')
        .filter((item) => targetLanguages.includes(item.language))
    : [];
  return {
    sourceLanguage: typeof parsed.sourceLanguage === 'string' ? parsed.sourceLanguage : 'unknown',
    translations,
    ambiguity: normalizeAmbiguity(parsed.ambiguity),
  };
}

function normalizeAmbiguity(value: unknown): TranslationResult['ambiguity'] {
  if (!value || typeof value !== 'object') return { hasAmbiguity: false };
  const ambiguity = value as Record<string, unknown>;
  return {
    hasAmbiguity: ambiguity.hasAmbiguity === true,
    reason: typeof ambiguity.reason === 'string' ? ambiguity.reason : undefined,
    suggestedQuestion: typeof ambiguity.suggestedQuestion === 'string' ? ambiguity.suggestedQuestion : undefined,
  };
}
