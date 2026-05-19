import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const imagePath = process.env.LINE_RICH_MENU_IMAGE_PATH ?? process.argv[2];
if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN is required');
if (!imagePath) throw new Error('LINE_RICH_MENU_IMAGE_PATH is required, or pass image path as first argument');

const richMenu = { size: { width: 2500, height: 843 }, selected: true, name: 'Tecxbot main menu', chatBarText: 'Tecxbot', areas: [area(0, '今日任務', 'menu:brief'), area(625, '搜尋資料', 'menu:search'), area(1250, '上傳/轉文字', 'menu:audio'), area(1875, 'AI 助理', 'menu:ai')] };
const created = await callJson('https://api.line.me/v2/bot/richmenu', richMenu, 'POST');
const richMenuId = created.richMenuId;
if (!richMenuId) throw new Error(`LINE did not return richMenuId: ${JSON.stringify(created)}`);
await callBinary(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, await readFile(imagePath), detectContentType(imagePath));
await callJson(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, undefined, 'POST');
console.log('LINE rich menu configured.');
console.log(JSON.stringify({ richMenuId, imagePath }, null, 2));

function area(x, label, data) { return { bounds: { x, y: 0, width: 625, height: 843 }, action: { type: 'postback', label, data, displayText: label } }; }
async function callJson(url, payload, method) {
  const response = await fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) });
  const text = await response.text();
  if (!response.ok) throw new Error(`LINE API failed: ${response.status} ${text}`);
  return text ? JSON.parse(text) : {};
}
async function callBinary(url, body, contentType) {
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType }, body });
  if (!response.ok) throw new Error(`LINE image upload failed: ${response.status} ${await response.text()}`);
}
function detectContentType(file) {
  const ext = extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  throw new Error('Rich menu image must be png, jpg, jpeg, or svg');
}
