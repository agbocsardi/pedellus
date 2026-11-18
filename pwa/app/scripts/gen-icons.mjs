#!/usr/bin/env node
// Generates the app icons as PNGs with zero dependencies: a small PNG writer
// (zlib is in the stdlib) plus a supersampled rasterizer for the "speech
// bubble" mark. Deterministic, re-run any time with `npm run icons`.
//
//   public/icons/icon-192.png          manifest, any
//   public/icons/icon-512.png         manifest, any
//   public/icons/apple-touch-icon-180.png  home-screen (opaque)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../public/icons");

const BG = [14, 122, 106]; // calm teal, same as theme_color
const GLYPH = [255, 255, 255];

// -- minimal PNG writer ----------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function png(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// -- shapes (unit square coordinates) --------------------------------------

function inRoundRect(u, v, cx, cy, hw, hh, r) {
  const dx = Math.abs(u - cx) - (hw - r);
  const dy = Math.abs(v - cy) - (hh - r);
  if (dx > r || dy > r) return false;
  if (dx <= 0 || dy <= 0) return true;
  return dx * dx + dy * dy <= r * r;
}

function inTriangle(u, v, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (u - bx) * (ay - by) - (ax - bx) * (v - by);
  const d2 = (u - cx) * (by - cy) - (bx - cx) * (v - cy);
  const d3 = (u - ax) * (cy - ay) - (cx - ax) * (v - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function inCircle(u, v, cx, cy, r) {
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= r * r;
}

const TAIL = [
  [0.33, 0.56],
  [0.41, 0.73],
  [0.49, 0.555],
];

function sample(u, v, opaque) {
  const inSquare = opaque || inRoundRect(u, v, 0.5, 0.5, 0.47, 0.47, 0.18);
  if (!inSquare) return null;
  const inBubble =
    inRoundRect(u, v, 0.5, 0.43, 0.23, 0.16, 0.08) || inTriangle(u, v, ...TAIL);
  if (!inBubble) return BG;
  for (const x of [0.4, 0.5, 0.6]) {
    if (inCircle(u, v, x, 0.43, 0.034)) return BG;
  }
  return GLYPH;
}

function render(size, opaque) {
  const SS = 4; // supersampling for smooth edges
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size, opaque);
          if (!c) continue;
          covered++;
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const at = (y * size + x) * 4;
      if (covered === 0) {
        px[at + 3] = 0;
        continue;
      }
      px[at] = Math.round(r / covered);
      px[at + 1] = Math.round(g / covered);
      px[at + 2] = Math.round(b / covered);
      px[at + 3] = opaque ? 255 : Math.round((255 * covered) / (SS * SS));
    }
  }
  return px;
}

mkdirSync(outDir, { recursive: true });
for (const [name, size, opaque] of [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["apple-touch-icon-180.png", 180, true], // opaque: iOS composites black behind alpha
]) {
  writeFileSync(resolve(outDir, name), png(size, size, render(size, opaque)));
  console.log(`wrote public/icons/${name}`);
}
