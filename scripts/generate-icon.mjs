import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const size = 64, scale = 4;
const shapes = [
  { points: [[14, 40], [32, 49], [50, 40], [50, 45], [32, 54], [14, 45]], color: [113, 133, 111] },
  { points: [[14, 30], [32, 39], [50, 30], [50, 35], [32, 44], [14, 35]], color: [148, 170, 144] },
  { points: [[14, 22], [32, 13], [50, 22], [32, 31]], color: [192, 209, 185] },
];
function inside(x, y, points) {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) result = !result;
  }
  return result;
}
const pixels = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const sum = [0, 0, 0, 0];
  for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
    const px = x + (sx + .5) / scale, py = y + (sy + .5) / scale;
    const cx = Math.max(14, Math.min(50, px)), cy = Math.max(14, Math.min(50, py));
    if ((px - cx) ** 2 + (py - cy) ** 2 > 14 ** 2) continue;
    let color = [32, 39, 34];
    for (const shape of shapes) if (inside(px, py, shape.points)) color = shape.color;
    for (let c = 0; c < 3; c++) sum[c] += color[c];
    sum[3] += 255;
  }
  const alphaSamples = sum[3] / 255, offset = y * (size * 4 + 1) + 1 + x * 4;
  for (let c = 0; c < 3; c++) pixels[offset + c] = alphaSamples ? Math.round(sum[c] / alphaSamples) : 0;
  pixels[offset + 3] = Math.round(sum[3] / (scale * scale));
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, bytes) {
  const type = Buffer.from(name), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
  return Buffer.concat([length, type, bytes, crc]);
}
const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico[6] = size; ico[7] = size; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
await mkdir(new URL('../src-tauri/icons/', import.meta.url), { recursive: true });
await writeFile(new URL('../src-tauri/icons/64x64.png', import.meta.url), png);
await writeFile(new URL('../src-tauri/icons/icon.ico', import.meta.url), Buffer.concat([ico, png]));
