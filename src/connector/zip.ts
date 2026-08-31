// Minimal, dependency-free ZIP reader.
//
// LINE delivers a .zip as application/octet-stream like any other file; get_file
// then unzips it here so the text files inside (a plugin's .php source, say) are
// readable, instead of reporting an opaque binary. Uses only node:zlib for
// DEFLATE — no third-party unzip dependency.
//
// This runs on untrusted client input, so it is bounded against zip bombs: a
// per-entry decompressed cap, a total cap, and an entry-count cap. Only the two
// common methods are supported — stored (0) and deflate (8); zip64 and encrypted
// entries are rejected rather than mis-parsed.

import { inflateRawSync } from 'node:zlib';

export type ZipEntry = { name: string; isDir: boolean; content: ArrayBuffer };

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

export type ParseZipOptions = { maxEntries?: number; maxEntryBytes?: number; maxTotalBytes?: number };

/** A file that begins with "PK" and a local/EOCD/spanning signature. */
export function looksLikeZip(content: ArrayBuffer): boolean {
  const b = new Uint8Array(content);
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07);
}

export function parseZip(content: ArrayBuffer, opts: ParseZipOptions = {}): ZipEntry[] {
  const maxEntries = opts.maxEntries ?? 200;
  const maxEntryBytes = opts.maxEntryBytes ?? 8 * 1024 * 1024;
  const maxTotalBytes = opts.maxTotalBytes ?? 24 * 1024 * 1024;

  const buf = Buffer.from(content);
  const eocd = findEocd(buf);
  if (!eocd) throw new Error('not a valid zip (no end-of-central-directory record)');

  const entries: ZipEntry[] = [];
  let ptr = eocd.cdOffset;
  let total = 0;

  for (let i = 0; i < eocd.count && i < maxEntries; i += 1) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== SIG_CENTRAL) break;
    const flags = buf.readUInt16LE(ptr + 8);
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const uncompSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) { entries.push({ name, isDir: true, content: new ArrayBuffer(0) }); continue; }
    if (flags & 0x1) throw new Error(`entry "${name}" is encrypted`);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) throw new Error('zip64 archives are not supported');

    // Locate the file data via the local header (its name/extra lengths can
    // differ from the central record, so read them here).
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`bad local header for "${name}"`);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) data = Buffer.from(new Uint8Array(comp));
    else if (method === 8) data = inflateRawSync(new Uint8Array(comp), { maxOutputLength: Math.min(maxEntryBytes, maxTotalBytes - total) });
    else throw new Error(`unsupported compression method ${method} for "${name}"`);

    total += data.length;
    if (total > maxTotalBytes) throw new Error('archive expands too large to read inline');
    entries.push({ name, isDir: false, content: toArrayBuffer(data) });
  }
  return entries;
}

function findEocd(buf: Buffer): { count: number; cdOffset: number } | undefined {
  // EOCD is 22 bytes plus an optional comment (<= 0xffff). Scan back from the end.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      return { count: buf.readUInt16LE(i + 10), cdOffset: buf.readUInt32LE(i + 16) };
    }
  }
  return undefined;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return copy.buffer;
}
