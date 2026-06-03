export type TranscribeLanguage = 'en' | 'zh-TW' | 'auto';

// Transcribe an audio/video buffer with Deepgram. Used for files the bot
// pulled from Telegram (<=20MB). Larger files go through the browser-direct
// upload page instead, which calls Deepgram with a minted short-lived key.
export async function transcribeAudio(input: { apiKey: string; audio: ArrayBuffer; contentType: string; language: TranscribeLanguage }): Promise<string> {
  const params = new URLSearchParams({ model: 'nova-3', punctuate: 'true', smart_format: 'true' });
  if (input.language === 'auto') params.set('language', 'multi');
  else params.set('language', input.language);
  const response = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${input.apiKey}`, 'Content-Type': input.contentType },
    body: input.audio,
  });
  if (!response.ok) throw new Error(`Deepgram failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } };
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
}
