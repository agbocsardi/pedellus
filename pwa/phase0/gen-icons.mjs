// Generates the two probe icons (a white ring on a blue square — a "0" for phase 0).
// Pure Node (zlib only, no dependencies). Run once: `node gen-icons.mjs`
// The PNGs are committed; this script is kept so they can be regenerated.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function renderIcon(s) {
  const bg = [70, 110, 230]; // #466ee6
  const fg = [255, 255, 255];
  const cx = s / 2, cy = s / 2;
  const rOuter = s * 0.30, rInner = s * 0.17;
  const px = Buffer.alloc(s * s * 3);
  // 2x2 supersampling for softer edges
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let hits = 0;
      for (const [dx, dy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const d = Math.hypot(x + dx - cx, y + dy - cy);
        if (d >= rInner && d <= rOuter) hits++;
      }
      const a = hits / 4;
      const i = (y * s + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        px[i + ch] = Math.round(bg[ch] * (1 - a) + fg[ch] * a);
      }
    }
  }
  return px;
}

function encodePng(s, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0);
  ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  const raw = Buffer.alloc(s * (s * 3 + 1));
  for (let y = 0; y < s; y++) {
    rgb.copy(raw, y * (s * 3 + 1) + 1, y * s * 3, (y + 1) * s * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(path.join(root, 'icons'), { recursive: true });
for (const s of [180, 512]) {
  const out = path.join(root, 'icons', `icon-${s}.png`);
  writeFileSync(out, encodePng(s, renderIcon(s)));
  console.log(`wrote ${out}`);
}
