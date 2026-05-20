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

export function renderPriceLinePng(input: { points: PricePoint[]; width?: number; height?: number }) {
  const width = input.width ?? 1200;
  const height = input.height ?? 630;
  const margin = { left: 70, right: 50, top: 50, bottom: 70 };
  const canvas = new Uint8ClampedArray(width * height * 4);
  fill(canvas, width, height, white);

  const points: Array<{ date?: string; close: number }> = [];
  for (const point of input.points) {
    const close = toNumber(point.close);
    if (close === undefined) continue;
    points.push(point.date ? { date: point.date, close } : { close });
  }

  drawGrid(canvas, width, height, margin);
  if (points.length < 2) return encodePng(width, height, canvas);

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
