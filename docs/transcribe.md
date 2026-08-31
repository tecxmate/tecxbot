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
(a few minutes of m4a). **Longer files (meetings, 10–60 min) use the browser
upload page instead — see "Long recordings" below.**

## Languages

Transcription runs on Deepgram `nova-3`. Pass `language=`:

| `language=` | Use for |
| --- | --- |
| `auto` (default) | Unsure — Deepgram detects the single dominant language (broad set incl. `vi`, `zh`). |
| `en` | English. |
| `zh-TW` | Traditional Chinese / Mandarin. |
| `vi` | Vietnamese. |
| `multi` | Code-switching **only** across EN + Spanish, French, German, Hindi, Russian, Portuguese, Japanese, Italian, Dutch. |

**Caveat:** no Deepgram model code-switches across English + Chinese + Vietnamese
in one file — `multi` does not include `zh` or `vi`. For a recording that mixes
those, pick the **dominant** language; the other-language stretches degrade. A
single-language recording is always most accurate with its language pinned
explicitly rather than `auto`.

## Long recordings (browser upload)

For files past ~4.5 MB, open **`/transcribe.html`** (e.g.
`https://tecxbot.vercel.app/transcribe.html`) on any device:

1. Paste the `TRANSCRIBE_SECRET` once (kept in that browser's localStorage).
2. Pick the spoken language, optionally set project / milestone / title / tags.
3. Choose the audio or video file and tap **Transcribe & save**.

The browser mints a short-lived Deepgram key from `/api/deepgram-token` (also
gated by `TRANSCRIBE_SECRET`) and uploads the file **straight to Deepgram**, so
Vercel's 4.5 MB request cap never applies. The finished transcript is shown,
copyable, and POSTed back to `/api/transcribe` as JSON to file it into project
memory — the same store the shortcut writes to. Multi-speaker files come back
with `[Speaker N]` labels.

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
