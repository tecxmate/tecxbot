// Cloudflare R2 client (S3-compatible), dependency-free.
//
// R2's object API is S3, which means AWS Signature V4. Rather than pull in an
// SDK, this signs requests with node:crypto — the signer is validated against
// the published AWS SigV4 test vector (see the smoke suite), so it is known
// correct even though the live round trip only happens in production.
//
// Configure with an R2 API token (Account → R2 → Manage API Tokens):
//   R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
// or set R2_ENDPOINT directly instead of R2_ACCOUNT_ID.

import { createHash, createHmac } from 'node:crypto';

const REGION = 'auto'; // R2 ignores region but SigV4 needs a value
const SERVICE = 's3';

export type R2Config = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string };

export function r2Config(): R2Config | undefined {
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT
    || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
  if (!bucket || !accessKeyId || !secretAccessKey || !endpoint) return undefined;
  return { endpoint: endpoint.replace(/\/+$/, ''), bucket, accessKeyId, secretAccessKey };
}

export function isR2Configured() {
  return Boolean(r2Config());
}

export async function putObject(key: string, body: Uint8Array, contentType: string): Promise<void> {
  const config = requireConfig();
  const url = objectUrl(config, key);
  const response = await signedFetch('PUT', url, {
    body,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    extraHeaders: { 'content-type': contentType },
  });
  if (!response.ok) throw new Error(`R2 put failed: ${response.status} ${await safeText(response)}`);
}

export async function getObject(key: string): Promise<{ body: ArrayBuffer; contentType: string } | undefined> {
  const config = requireConfig();
  const url = objectUrl(config, key);
  const response = await signedFetch('GET', url, { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`R2 get failed: ${response.status} ${await safeText(response)}`);
  return { body: await response.arrayBuffer(), contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
}

function requireConfig(): R2Config {
  const config = r2Config();
  if (!config) throw new Error('R2 is not configured (set R2_ACCOUNT_ID/R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)');
  return config;
}

function objectUrl(config: R2Config, key: string) {
  const path = `/${config.bucket}/${key.split('/').map(encodeSegment).join('/')}`;
  return new URL(path, config.endpoint).toString();
}

// ---- SigV4 ----

type SignInput = {
  body?: Uint8Array;
  accessKeyId: string;
  secretAccessKey: string;
  extraHeaders?: Record<string, string>;
  now?: Date;
};

async function signedFetch(method: string, url: string, input: SignInput) {
  const signed = signRequest({ method, url, ...input });
  const init: RequestInit = { method, headers: signed };
  if (input.body) init.body = new Uint8Array(input.body);
  return fetch(url, init);
}

// Exported for the test suite to check against the AWS SigV4 test vector.
export function signRequest(params: {
  method: string;
  url: string;
  body?: Uint8Array;
  accessKeyId: string;
  secretAccessKey: string;
  extraHeaders?: Record<string, string>;
  now?: Date;
  region?: string;
  service?: string;
}): Record<string, string> {
  const region = params.region ?? REGION;
  const service = params.service ?? SERVICE;
  const url = new URL(params.url);
  const now = params.now ?? new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(params.body ?? new Uint8Array());

  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...lowerKeys(params.extraHeaders ?? {}),
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    params.method,
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(new TextEncoder().encode(canonicalRequest))].join('\n');

  const signingKey = deriveSigningKey(params.secretAccessKey, dateStamp, region, service);
  const signature = createHmac('sha256', new Uint8Array(signingKey)).update(stringToSign).digest('hex');

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${params.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function deriveSigningKey(secret: string, dateStamp: string, region: string, service: string) {
  const kDate = createHmac('sha256', `AWS4${secret}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', new Uint8Array(kDate)).update(region).digest();
  const kService = createHmac('sha256', new Uint8Array(kRegion)).update(service).digest();
  return createHmac('sha256', new Uint8Array(kService)).update('aws4_request').digest();
}

function canonicalPath(pathname: string) {
  // The path is already percent-encoded by objectUrl/URL; S3 expects each
  // segment encoded with '/' preserved, which is what we have.
  return pathname || '/';
}

function canonicalQuery(params: URLSearchParams) {
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of params) pairs.push([encodeRfc3986(key), encodeRfc3986(value)]);
  return pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
}

function toAmzDate(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function sha256Hex(data: Uint8Array) {
  return createHash('sha256').update(data).digest('hex');
}

function lowerKeys(headers: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value;
  return out;
}

// Path segment encoding: RFC 3986 unreserved stay literal; everything else
// percent-encoded. AWS treats these characters the same way.
function encodeSegment(segment: string) {
  return encodeRfc3986(segment);
}

function encodeRfc3986(value: string) {
  return encodeURIComponent(value).replace(/[!*'()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function safeText(response: Response) {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}
