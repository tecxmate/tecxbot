type TeacherTurn = { role: 'user' | 'assistant'; text: string };

export type VietnameseTeacherConfig = { appName: string; appTagline?: string; appUrl?: string };

// Ask the OpenAI-backed Vietnamese teacher. Explains in whatever language the
// learner wrote in, always grounding answers with Vietnamese examples.
export async function askVietnameseTeacher(input: {
  apiKey: string;
  config: VietnameseTeacherConfig;
  question: string;
  history?: TeacherTurn[];
  context: 'group' | 'direct';
}): Promise<string> {
  const appLine = [input.config.appName, input.config.appTagline].filter(Boolean).join(' — ');
  const systemPrompt = `You are a warm, encouraging Vietnamese language teacher inside ${input.config.appName}, a Vietnamese learning app.

Your job:
- Help learners with Vietnamese vocabulary, grammar, pronunciation, tones, sentence construction, everyday usage, and culture.
- Always reply in the SAME language the learner used in their latest message (English → English, Traditional Chinese → 繁體中文, Vietnamese → simple Vietnamese).
- Whenever you teach a word or phrase, show the Vietnamese, a short pronunciation hint, and the meaning.
- Be concise and chat-friendly: short paragraphs, use examples, suitable for a messaging app.
- Encourage the learner and invite a follow-up question.

About the app (mention briefly only when the learner greets you, asks what this is, or seems new):
${appLine}${input.config.appUrl ? `\nLink: ${input.config.appUrl}` : ''}

Boundaries:
- Stay focused on learning Vietnamese and on the app. If asked something unrelated, gently steer back to Vietnamese practice.
- Do not invent app features you are unsure about.${input.context === 'group' ? '\n- You are in a group chat and were mentioned. Keep replies tight and on-topic.' : ''}`;

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...(input.history ?? []).map((turn) => ({ role: turn.role, content: turn.text })),
    { role: 'user' as const, content: input.question },
  ];

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_TEACHER_MODEL || process.env.OPENAI_TRANSLATION_MODEL || 'gpt-4o-mini',
      temperature: 0.4,
      messages,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI teacher failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  return data.choices?.[0]?.message?.content?.trim() || '';
}
