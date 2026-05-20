import { deflateSync } from 'node:zlib';

export type PricePoint = {
  date?: string;
  close?: number | string | null;
};

type Rgba = [number, number, number, number];

const white: Rgba = [255, 255, 255, 255];
const grid: Rgba = [226, 232, 240, 255];
const axis: Rgba = [148, 163, 184, 255];
const line: Rgba = [14, 116, 144, 255];
const dot: Rgba = [8, 145, 178, 255];
const text: Rgba = [15, 23, 42, 255];
const mutedText: Rgba = [100, 116, 139, 255];

export function renderPriceLinePng(input: { points: PricePoint[]; width?: number; height?: number; title?: string; subtitle?: string }) {
  const width = input.width ?? 1200;
  const height = input.height ?? 630;
  const margin = { left: 86, right: 120, top: 110, bottom: 92 };
  const canvas = new Uint8ClampedArray(width * height * 4);
  fill(canvas, width, height, white);
  drawText(canvas, width, height, input.title ?? 'PRICE CHART', 70, 34, 5, text);
  if (input.subtitle) drawText(canvas, width, height, input.subtitle, 72, 78, 3, mutedText);

  const points: Array<{ date?: string; close: number }> = [];
  for (const point of input.points) {
    const close = toNumber(point.close);
    if (close === undefined) continue;
    points.push(point.date ? { date: point.date, close } : { close });
  }

  drawGrid(canvas, width, height, margin);
  if (points.length < 2) {
    drawText(canvas, width, height, 'NO CHART DATA', margin.left + 18, margin.top + 40, 4, mutedText);
    return encodePng(width, height, canvas);
  }

  const closes = points.map((point) => point.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const pad = Math.max((max - min) * 0.08, max * 0.01, 1);
  const yMin = min - pad;
  const yMax = max + pad;
  const chartW = width - margin.left - margin.right;
  const chartH = height - margin.top - margin.bottom;
  const coords = points.map((point, index) => {
    const x = margin.left + (index / Math.max(1, points.length - 1)) * chartW;
    const y = margin.top + (1 - (point.close - yMin) / Math.max(1, yMax - yMin)) * chartH;
    return { x, y };
  });
  const latest = points.at(-1);
  const first = points[0];
  const mid = (yMin + yMax) / 2;

  drawText(canvas, width, height, `HIGH ${formatNumber(yMax)}`, width - 108, margin.top - 3, 2, mutedText);
  drawText(canvas, width, height, formatNumber(mid), width - 108, margin.top + chartH / 2 - 7, 2, mutedText);
  drawText(canvas, width, height, `LOW ${formatNumber(yMin)}`, width - 108, margin.top + chartH - 13, 2, mutedText);
  if (first?.date) drawText(canvas, width, height, shortDate(first.date), margin.left, margin.top + chartH + 28, 3, mutedText);
  if (latest?.date) drawText(canvas, width, height, shortDate(latest.date), margin.left + chartW - 118, margin.top + chartH + 28, 3, mutedText);
  if (latest) drawText(canvas, width, height, `LAST ${formatNumber(latest.close)}`, width - 310, 45, 4, line);

  for (let index = 1; index < coords.length; index += 1) {
    drawLine(canvas, width, height, coords[index - 1].x, coords[index - 1].y, coords[index].x, coords[index].y, line, 5);
  }
  const last = coords.at(-1);
  if (last) drawCircle(canvas, width, height, last.x, last.y, 8, dot);
  return encodePng(width, height, canvas);
}

function drawGrid(canvas: Uint8ClampedArray, width: number, height: number, margin: { left: number; right: number; top: number; bottom: number }) {
  const chartW = width - margin.left - margin.right;
  const chartH = height - margin.top - margin.bottom;
  for (let i = 0; i <= 4; i += 1) {
    const y = margin.top + (i / 4) * chartH;
    drawLine(canvas, width, height, margin.left, y, margin.left + chartW, y, grid, 2);
  }
  for (let i = 0; i <= 5; i += 1) {
    const x = margin.left + (i / 5) * chartW;
    drawLine(canvas, width, height, x, margin.top, x, margin.top + chartH, grid, 1);
  }
  drawLine(canvas, width, height, margin.left, margin.top, margin.left, margin.top + chartH, axis, 3);
  drawLine(canvas, width, height, margin.left, margin.top + chartH, margin.left + chartW, margin.top + chartH, axis, 3);
}

function fill(canvas: Uint8ClampedArray, width: number, height: number, color: Rgba) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) setPixel(canvas, width, height, x, y, color);
  }
}

function drawLine(canvas: Uint8ClampedArray, width: number, height: number, x0: number, y0: number, x1: number, y1: number, color: Rgba, thickness = 1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
  for (let i = 0; i <= steps; i += 1) {
    const x = x0 + (dx * i) / steps;
    const y = y0 + (dy * i) / steps;
    drawCircle(canvas, width, height, x, y, thickness / 2, color);
  }
}

function drawCircle(canvas: Uint8ClampedArray, width: number, height: number, cx: number, cy: number, radius: number, color: Rgba) {
  const r = Math.ceil(radius);
  for (let y = Math.floor(cy) - r; y <= Math.floor(cy) + r; y += 1) {
    for (let x = Math.floor(cx) - r; x <= Math.floor(cx) + r; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2) setPixel(canvas, width, height, x, y, color);
    }
  }
}

function setPixel(canvas: Uint8ClampedArray, width: number, height: number, x: number, y: number, color: Rgba) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= width || iy >= height) return;
  const offset = (iy * width + ix) * 4;
  canvas[offset] = color[0];
  canvas[offset + 1] = color[1];
  canvas[offset + 2] = color[2];
  canvas[offset + 3] = color[3];
}

function drawText(canvas: Uint8ClampedArray, width: number, height: number, value: string, x: number, y: number, scale: number, color: Rgba) {
  let cursor = x;
  const normalized = value.toUpperCase().slice(0, 42);
  for (const char of normalized) {
    const glyph = font[char] ?? font['?'];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] !== '1') continue;
        fillRect(canvas, width, height, cursor + col * scale, y + row * scale, scale, scale, color);
      }
    }
    cursor += (glyph[0].length + 1) * scale;
  }
}

function fillRect(canvas: Uint8ClampedArray, width: number, height: number, x: number, y: number, rectWidth: number, rectHeight: number, color: Rgba) {
  for (let py = 0; py < rectHeight; py += 1) {
    for (let px = 0; px < rectWidth; px += 1) setPixel(canvas, width, height, x + px, y + py, color);
  }
}

function formatNumber(value: number) {
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  if (Math.abs(value) >= 100) return value.toFixed(1);
  return value.toFixed(2);
}

function shortDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[2]}/${match[3]}` : value.slice(0, 8);
}

const font: Record<string, string[]> = {
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
  '?': ['11110', '00001', '00001', '00110', '00100', '00000', '00100'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['000', '000', '000', '000', '000', '110', '110'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  ':': ['000', '110', '110', '000', '110', '110', '000'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  'D': ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  'N': ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  'W': ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  'Y': ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
};

function encodePng(width: number, height: number, rgba: Uint8ClampedArray) {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }
  return concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr(width, height)),
    chunk('IDAT', Uint8Array.from(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function ihdr(width: number, height: number) {
  const buffer = new Uint8Array(13);
  writeUInt32BE(buffer, width, 0);
  writeUInt32BE(buffer, height, 4);
  buffer[8] = 8;
  buffer[9] = 6;
  buffer[10] = 0;
  buffer[11] = 0;
  buffer[12] = 0;
  return buffer;
}

function chunk(type: string, data: Uint8Array) {
  const typeBuffer = asciiBytes(type);
  const length = new Uint8Array(4);
  writeUInt32BE(length, data.length, 0);
  const crc = new Uint8Array(4);
  writeUInt32BE(crc, crc32(concatBytes([typeBuffer, data])), 0);
  return concatBytes([length, typeBuffer, data, crc]);
}

function concatBytes(chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((sum, chunkItem) => sum + chunkItem.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunkItem of chunks) {
    output.set(chunkItem, offset);
    offset += chunkItem.length;
  }
  return output;
}

function asciiBytes(text: string) {
  const output = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) output[index] = text.charCodeAt(index) & 0xff;
  return output;
}

function writeUInt32BE(buffer: Uint8Array, value: number, offset: number) {
  buffer[offset] = (value >>> 24) & 0xff;
  buffer[offset + 1] = (value >>> 16) & 0xff;
  buffer[offset + 2] = (value >>> 8) & 0xff;
  buffer[offset + 3] = value & 0xff;
}

function crc32(buffer: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
