import type { TenantConfig, TranscriptLanguage } from './types.js';

export type DeepgramTranscription = { transcript: string; speakers: number[] };

export async function transcribeWithDeepgram(input: { apiKey: string; audio: ArrayBuffer; contentType: string; language: TranscriptLanguage | 'auto' }): Promise<DeepgramTranscription> {
  const base = { model: 'nova-3', punctuate: 'true', smart_format: 'true', diarize: 'true', paragraphs: 'true', utterances: 'true', numerals: 'true' };
  // 'auto' lets Deepgram detect the language (a recording may be English or
  // Chinese); a fixed language is more accurate when you know it.
  const params = new URLSearchParams(input.language === 'auto' ? { ...base, detect_language: 'true' } : { ...base, language: input.language });
  const response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, { method: 'POST', headers: { Authorization: `Token ${input.apiKey}`, 'Content-Type': input.contentType }, body: input.audio });
  if (!response.ok) throw new Error(`Deepgram failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string; words?: Array<{ word: string; speaker?: number }> }> }> } };
  const alt = data.results?.channels?.[0]?.alternatives?.[0];
  if (!alt) return { transcript: '', speakers: [] };
  const words = alt.words ?? [];
  if (words.length === 0 || words[0].speaker === undefined) return { transcript: alt.transcript ?? '', speakers: [] };
  const lines: string[] = [];
  let curSpeaker = words[0].speaker;
  let curWords: string[] = [];
  for (const word of words) {
    const nextSpeaker = word.speaker ?? curSpeaker;
    if (nextSpeaker !== curSpeaker) {
      lines.push(`[Speaker ${curSpeaker}] ${curWords.join(' ')}`);
      curSpeaker = nextSpeaker;
      curWords = [];
    }
    curWords.push(word.word);
  }
  lines.push(`[Speaker ${curSpeaker}] ${curWords.join(' ')}`);
  return { transcript: lines.join('\n'), speakers: Array.from(new Set(words.map((word) => word.speaker).filter((speaker) => speaker !== undefined))).sort() as number[] };
}

export async function polishTranscript(input: { apiKey: string; tenant: TenantConfig; rawTranscript: string; language: TranscriptLanguage }) {
  if (!input.rawTranscript.trim()) return '';
  const targetLanguage = input.language === 'en' ? 'English' : 'Traditional Chinese';
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.1, messages: [
      { role: 'system', content: `You polish raw ASR transcripts for this business context:\n\n${input.tenant.domainContext}\n\nRewrite into clean, readable ${targetLanguage}. Preserve speaker labels, meaning, uncertainty, and domain terms. Do not add facts. Return only the polished transcript.` },
      { role: 'user', content: `Raw transcript:\n\n${input.rawTranscript}` },
    ] }),
  });
  if (!response.ok) {
    console.error('[polish-transcript] OpenAI failed:', response.status, await response.text());
    return input.rawTranscript;
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  return data.choices?.[0]?.message?.content?.trim() || input.rawTranscript;
}
