// How to render a file fetched from a conversation: as an image, as inline text,
// or as an unreadable binary.
//
// LINE serves every file attachment as `application/octet-stream` regardless of
// what it actually is, so content-type alone is not enough — a Markdown spec, a
// CSV, or a plain-text note all arrive as generic binary. We recover the real
// kind from the filename extension (captured in the "[file: name]" placeholder)
// and, failing that, by sniffing whether the bytes decode as UTF-8 text.

export type FileRendering =
  | { kind: 'image' }
  | { kind: 'text'; text: string }
  | { kind: 'binary'; reason: 'too_big' | 'not_text' };

// Extensions we treat as inline-readable text.
const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'json', 'ndjson', 'xml', 'yaml', 'yml',
  'toml', 'ini', 'conf', 'cfg', 'env', 'properties', 'log', 'html', 'htm', 'css',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'sql', 'sh', 'bash', 'zsh', 'py', 'rb', 'go',
  'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'php', 'pl', 'lua', 'r', 'swift', 'srt',
  'vtt', 'gradle', 'dockerfile', 'makefile', 'gitignore', 'diff', 'patch',
]);

/** Pull the original filename out of a "[file: quote.pdf]" capture placeholder. */
export function fileNameFromPlaceholder(text: string): string | undefined {
  const match = /\[file:\s*(.+?)\]\s*$/.exec(text.trim());
  const name = match?.[1]?.trim();
  return name && name !== 'unnamed' ? name : undefined;
}

function extensionOf(name?: string): string | undefined {
  if (!name) return undefined;
  const base = (name.split('/').pop() ?? name).toLowerCase();
  const dot = base.lastIndexOf('.');
  // No dot → use the whole name so "Dockerfile" / "Makefile" still match.
  return dot > 0 ? base.slice(dot + 1) : base;
}

export function isTextExtension(name?: string): boolean {
  const ext = extensionOf(name);
  return ext ? TEXT_EXTENSIONS.has(ext) : false;
}

function isRecognizedTextType(contentType: string): boolean {
  return /^text\//.test(contentType) || /(json|csv|xml|yaml|markdown|javascript|x-www-form-urlencoded)/.test(contentType);
}

function isGenericBinaryType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct === '' || ct === 'application/octet-stream' || ct === 'application/unknown' || ct === 'binary/octet-stream';
}

function hasNulByte(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) if (bytes[i] === 0) return true;
  return false;
}

/**
 * Sniff whether bytes are UTF-8 text: valid UTF-8, no NUL, and control
 * characters (other than tab/newline/CR) only a tiny fraction. Used when the
 * content-type is generic and the filename gives no hint.
 */
export function looksLikeUtf8Text(content: ArrayBuffer): boolean {
  const bytes = new Uint8Array(content);
  if (bytes.length === 0) return false;
  if (hasNulByte(bytes)) return false;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false; // invalid UTF-8 → binary
  }
  let control = 0;
  for (const ch of decoded) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) control += 1;
  }
  return control / decoded.length < 0.05;
}

function decodeUtf8(content: ArrayBuffer): string | undefined {
  const bytes = new Uint8Array(content);
  if (hasNulByte(bytes)) return undefined; // NUL byte → treat as binary
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Decide how to present a fetched file. `image/*` is an image; text is anything
 * whose content-type, filename extension, or byte content says text (and fits
 * the inline size cap); everything else is opaque binary.
 */
export function decideFileRendering(input: {
  contentType: string;
  fileName?: string;
  content: ArrayBuffer;
  maxTextBytes: number;
}): FileRendering {
  const { contentType, fileName, content, maxTextBytes } = input;
  if (contentType.toLowerCase().startsWith('image/')) return { kind: 'image' };

  const wantsText =
    isRecognizedTextType(contentType) ||
    isTextExtension(fileName) ||
    (isGenericBinaryType(contentType) && looksLikeUtf8Text(content));
  if (!wantsText) return { kind: 'binary', reason: 'not_text' };
  if (content.byteLength > maxTextBytes) return { kind: 'binary', reason: 'too_big' };

  const text = decodeUtf8(content);
  if (text === undefined) return { kind: 'binary', reason: 'not_text' };
  return { kind: 'text', text };
}
