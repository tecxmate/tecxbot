// Seed a demo tenant with a believable project, for the blog walkthrough.
//
//   DEMO_DATABASE_URL=postgres://... node scripts/seed-demo.mjs --yes
//
// Why this exists: the production deployment cannot be the demo. /api/mcp and
// /api/export expose every captured conversation under one token, and those
// conversations are real clients. A demo needs its own database with invented
// people in it.
//
// Three guards, all fail-closed, because the failure this must never have is
// "seeded fake messages into the live client log":
//   1. DEMO_DATABASE_URL must be set explicitly. Nothing is inferred.
//   2. It must differ from CONNECTOR_DATABASE_URL and DATABASE_URL if those are
//      set in this shell — that is the shape of the accident.
//   3. The target database must contain no conversation outside the demo
//      tenant. Pointing this at a real deployment aborts before writing.
// --yes is required on top of all three.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TENANT = 'showcase';
const CHANNEL = 'showcase-line';
const CONVERSATION = 'Cshowcase0001';
const PROJECT = 'lotus-rebuild';

const args = new Set(process.argv.slice(2));
const confirmed = args.has('--yes');

const demoUrl = process.env.DEMO_DATABASE_URL?.trim();
if (!demoUrl) {
  fail('DEMO_DATABASE_URL is not set. This script never guesses which database to write to.');
}
for (const name of ['CONNECTOR_DATABASE_URL', 'DATABASE_URL']) {
  const live = process.env[name]?.trim();
  if (live && live === demoUrl) {
    fail(`DEMO_DATABASE_URL is the same as ${name}. Refusing to seed fake conversations into a real deployment.`);
  }
}

// The store reads CONNECTOR_DATABASE_URL, so point it at the demo database
// before anything is imported.
process.env.CONNECTOR_DATABASE_URL = demoUrl;
delete process.env.DATABASE_URL;

const DIST = pathToFileURL(resolve(process.env.SMOKE_DIST || 'dist')).href;
const { recordMessage, listConversations, storeBackend } = await import(`${DIST}/src/core/conversationStore.js`);
const { saveNote } = await import(`${DIST}/src/core/noteStore.js`);

if (storeBackend() !== 'postgres') {
  fail('The store did not come up on postgres — the demo would vanish on the next cold start. Check DEMO_DATABASE_URL.');
}

const existing = await listConversations({ limit: 200 });
const foreign = existing.filter((conversation) => conversation.tenantId !== TENANT);
if (foreign.length) {
  fail([
    `This database already holds ${foreign.length} conversation(s) outside the "${TENANT}" tenant:`,
    ...foreign.slice(0, 5).map((conversation) => `  - ${conversation.tenantId}: ${conversation.title ?? conversation.conversationId}`),
    'That looks like a real deployment. Refusing to write.',
  ].join('\n'));
}

if (!confirmed) {
  console.log(`Would seed the "${TENANT}" tenant into the configured demo database. Re-run with --yes to write.`);
  process.exit(0);
}

const DAY = 86_400_000;
const now = Date.now();
const at = (daysAgo, hour = 10, minute = 0) => {
  const date = new Date(now - daysAgo * DAY);
  date.setUTCHours(hour, minute, 0, 0);
  return date.getTime();
};

// A small café chain rebuilding its site and adding online ordering. Written to
// contain the things a PM actually has to catch: a dated promise, a scope
// change agreed in passing, and a complaint.
const CLIENT = { id: 'Udemo-client-0001', name: '陳怡君 (Lotus)' };
const BRIAN = { id: 'Udemo-brian-0001', name: 'Brian' };
const NIKO = { id: 'Udemo-niko-0001', name: 'Niko' };

const messages = [
  [14, 9, 12, CLIENT, '早安！我們想把官網改版，順便加上線上訂購。目前的網站手機版很慢，客人常常抱怨。'],
  [14, 9, 20, BRIAN, 'Morning 怡君. Understood — rebuild plus online ordering, and mobile speed is the headline problem. Can you send the current traffic numbers and your POS provider?'],
  [14, 9, 41, CLIENT, 'POS 是 iCHEF。流量我請同事整理給你。另外我們三家店的菜單不太一樣，可以分開管理嗎？'],
  [14, 10, 2, BRIAN, 'Yes — three stores, separate menus, one admin. That is a per-location menu model rather than a single catalogue, so I will scope it properly and come back with a number.'],
  [13, 11, 30, NIKO, 'iCHEF has an open ordering API, so the integration is straightforward. The per-location menus are the real work.'],
  [12, 15, 5, BRIAN, '怡君, scope and quote sent to your email. Summary: rebuild, 3 location menus, iCHEF ordering, 6 weeks.'],
  [11, 9, 50, CLIENT, '收到，老闆同意了。什麼時候可以看到東西？'],
  // The dated promise. The weekly update and the reminder both hang off this.
  [11, 10, 3, BRIAN, 'We will have a staging link for you to click through on the 14th. Design first, then ordering.'],
  [9, 14, 22, CLIENT, '請問發票可以開公司抬頭嗎？統編 24536789。'],
  [9, 14, 40, NIKO, '沒問題，已經記下來了，下次請款會用這個統編。'],
  [6, 16, 11, CLIENT, '對了，可以順便加一個會員集點嗎？客人一直問。'],
  // Agreed in passing, never written down anywhere else. This is what the
  // "untracked commitments" recipe is supposed to surface.
  [6, 16, 25, BRIAN, 'Loyalty points — yes, we can do that. Let me check what iCHEF exposes before we commit to a date.'],
  [4, 10, 15, CLIENT, '手機版還是有點慢耶，是不是圖片太大？'],
  [4, 10, 48, NIKO, 'Images are part of it. We are moving them to a CDN and switching to WebP this week — should cut first load by about half.'],
  [2, 9, 30, CLIENT, '謝謝！那 14 號的連結我們會找時間一起看。'],
];

let recorded = 0;
for (const [daysAgo, hour, minute, who, text] of messages) {
  await recordMessage({
    tenantId: TENANT,
    channelId: CHANNEL,
    platform: 'line',
    conversationType: 'group',
    externalConversationId: CONVERSATION,
    title: 'Lotus 茶飲 — 官網改版',
    direction: who === CLIENT ? 'inbound' : 'outbound',
    senderId: who.id,
    senderName: who.name,
    text,
    messageType: 'text',
    externalMessageId: `demo-${daysAgo}-${hour}-${minute}`,
    at: at(daysAgo, hour, minute),
  });
  recorded += 1;
}

const conversationId = `line:${CHANNEL}:group:${CONVERSATION}`;
const notes = [
  {
    title: `${PROJECT} — brief`,
    body: [
      'Lotus 茶飲 (3 stores, Taichung) — website rebuild plus online ordering.',
      '',
      'Scope: responsive rebuild, per-location menus, iCHEF ordering integration.',
      'Timeline: 6 weeks from 2026-09-15. Staging walkthrough promised for the 14th.',
      'Contacts: 陳怡君 (owner). Billing 統編 24536789.',
      '',
      'Open: loyalty points was agreed verbally and is not scoped or dated.',
      'Watch: mobile performance — the reason they came to us, and still unresolved.',
    ].join('\n'),
    tags: ['brief'],
    project: PROJECT,
    occurredAt: at(2),
  },
  {
    title: 'Per-location menus rather than one shared catalogue',
    body: 'Each of the three stores runs a different menu, so a single catalogue with per-store visibility flags would have forced staff to manage exceptions. Agreed with 怡君 on the call: three menu sets, one admin, one ordering flow.',
    tags: ['decision', 'TECX-118'],
    project: PROJECT,
    occurredAt: at(12),
  },
  {
    title: 'Invoice to company 統編 24536789',
    body: 'Billing goes to the company entity, not the shop. Confirmed in the LINE group on the 9th.',
    tags: ['decision'],
    project: PROJECT,
    occurredAt: at(9),
  },
  {
    title: 'Images to CDN and WebP before the staging walkthrough',
    body: 'Mobile first-load is the complaint that started the project, so it has to be visibly better by the 14th, not after.',
    tags: ['decision', 'TECX-124'],
    project: PROJECT,
    occurredAt: at(4),
  },
  {
    // Overdue on purpose: the daily brief and project_status should both surface it.
    title: 'Send Lotus the staging link',
    body: 'Promised in the LINE group for the 14th. Design pass is done; ordering flow is still behind a feature flag.',
    tags: ['reminder'],
    project: PROJECT,
    occurredAt: at(1),
  },
  {
    title: 'Confirm what iCHEF exposes for loyalty points',
    body: 'Needed before we can give 怡君 a date for the points feature. Until then it is an open promise with no scope.',
    tags: ['reminder'],
    project: PROJECT,
    occurredAt: at(-3),
  },
  {
    title: 'Kickoff call — Lotus 官網改版',
    body: [
      'Attendees: 陳怡君, Brian, Niko.',
      '',
      '怡君 walked through the current site on her phone and showed the load time on 4G.',
      'Three stores, three menus; the Taichung store has a seasonal menu that changes monthly.',
      'They do not want an app — ordering has to work in LINE and the browser.',
      'Budget approved by the owner. Invoice to the company entity.',
    ].join('\n'),
    source: 'transcript',
    tags: ['meeting', 'TECX-118'],
    project: PROJECT,
    participants: ['陳怡君', 'Brian', 'Niko'],
    occurredAt: at(12, 15, 0),
  },
];

for (const note of notes) {
  await saveNote({ tenantId: TENANT, conversationId, ...note });
}

console.log(`Seeded the "${TENANT}" tenant.`);
console.log(`  ${recorded} messages in "Lotus 茶飲 — 官網改版" (${conversationId})`);
console.log(`  ${notes.length} notes: 1 brief, 3 decisions, 2 reminders (1 overdue), 1 meeting transcript`);
console.log('');
console.log('Point the demo deployment at this database with CONNECTOR_TENANT_ID=showcase, then ask Claude:');
console.log('  "Where does lotus-rebuild stand?"            — project_status: brief, reminders, decisions');
console.log('  "What did we promise that is not tracked?"   — finds the loyalty-points commitment');
console.log('  "Draft this week\'s update for the client."   — weekly client update from the log');

function fail(message) {
  console.error(`seed-demo: ${message}`);
  process.exit(1);
}
