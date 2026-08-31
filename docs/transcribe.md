# Speech-to-text ingest — record → Share → text (no LINE)

`POST /api/transcribe` turns a shared audio recording into text with Deepgram and
files it into the connector's **project memory** (see `docs/claude-connector.md`
§11), so Claude can tag and organize it later. It's platform-agnostic — an
iOS/Android share-sheet shortcut, `curl`, or any HTTP client can use it. No LINE
involved.

```text
POST https://tecxbot.vercel.app/api/transcribe
  body:    the audio bytes (m4a, mp3, wav, …)
  auth:    Authorization: Bearer <TRANSCRIBE_SECRET>   or   ?key=<TRANSCRIBE_SECRET>
  query:   language=auto|en|zh-TW   (default auto — detects English vs Chinese)
           save=1                    (default; save=0 to just get text back)
           title=, project=, milestone=, tags=a,b, participants=a,b
  returns: { "text": "...", "language": "auto", "noteId": "note_..." }
```

Recordings cap at Vercel's ~4.5 MB request limit — fine for typical voice memos
(a few minutes of m4a). Longer files would use the browser-direct upload flow
(`api/deepgram-token.ts` + `public/upload.html`).

## Setup

1. In Vercel, set `DEEPGRAM_API_KEY` (already set if LINE voice transcription
   works) and a new `TRANSCRIBE_SECRET` (`openssl rand -hex 32`). The endpoint is
   **fail-closed** — disabled until `TRANSCRIBE_SECRET` is set. Redeploy.
2. Test it:

   ```bash
   curl -s -X POST "https://tecxbot.vercel.app/api/transcribe?language=auto" \
     -H "Authorization: Bearer $TRANSCRIBE_SECRET" \
     --data-binary @memo.m4a
   ```

## iOS Shortcut (native share sheet)

Create a shortcut named e.g. **"Transcribe"** and enable **Show in Share Sheet**,
accepting **audio / files**:

1. **Receive** audio from the share sheet (Shortcut Input).
2. **Get Contents of URL**
   - URL: `https://tecxbot.vercel.app/api/transcribe?language=auto&save=1`
   - Method: `POST`
   - Headers: `Authorization` → `Bearer <TRANSCRIBE_SECRET>`
   - Request Body: **File** → the Shortcut Input.
3. **Get Dictionary Value** `text` from the response.
4. **Show Result** (or **Copy to Clipboard**, or **Quick Look**).

Now: record a voice memo → **Share** → **Transcribe** → the text comes back, and
(with `save=1`) it's already in project memory for Claude to tag by project and
milestone. Add `&project=ogsmbooster` to the URL to pre-file it under a project.

## Android

Android's built-in shortcuts can't POST a file, so use a helper that registers a
share target — **HTTP Shortcuts** (free, open source) or **Tasker**:

- Trigger: share → the app's share target.
- Action: `POST` the shared file to the same URL with the `Authorization` header,
  then show/copy the `text` field of the JSON response.

## Security

The endpoint is secret-gated and uses your Deepgram quota, so keep
`TRANSCRIBE_SECRET` private (a URL with `?key=` can land in logs — prefer the
`Authorization` header where the client supports it, and rotate the secret if it
leaks). Transcripts are saved to the same tenant the connector serves.
