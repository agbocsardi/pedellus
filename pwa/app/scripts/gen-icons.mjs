#!/usr/bin/env node
// Generates the default app icons as PNGs with zero dependencies: a small PNG
// writer (zlib is in the stdlib) plus a supersampled rasterizer for the
// default nondescript helper robot mark (matching src/Avatar.tsx).
// Deterministic, re-run any time with `npm run icons`.
//
//   public/icons/icon-192.png              manifest, any
//   public/icons/icon-512.png              manifest, any
//   public/icons/apple-touch-icon-180.png  home-screen (opaque)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), "../public/icons");

const BG = [23, 25, 23];          // dark app canvas (#171917)
const STROKE = [185, 197, 201];   // #b9c5c9
const SHELL = [91, 108, 116];     // #5b6c74
const SHADE = [67, 84, 94];       // #43545e
const VISOR = [23, 32, 36];       // #172024
const ACCENT = [79, 191, 169];    // #4fbfa9
const GLINT = [244, 251, 249];    // #f4fbf9

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

// -- shapes (64x64 avatar coordinate space mapped into [0, 1]) -------------

function inRoundRect(x, y, rx, ry, w, h, r) {
  const cx = rx + w / 2;
  const cy = ry + h / 2;
  const hw = w / 2;
  const hh = h / 2;
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  if (dx > r || dy > r) return false;
  if (dx <= 0 || dy <= 0) return true;
  return dx * dx + dy * dy <= r * r;
}

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function sample(u, v, opaque) {
  if (!opaque && !inRoundRect(u, v, 0.03, 0.03, 0.94, 0.94, 0.2)) return null;

  // Map [0, 1] into a padded 64x64 viewBox (centered slightly lower for optical balance).
  const x = u * 64;
  const y = v * 64 - 2.5;

  // Glints inside eyes
  if (inCircle(x, y, 22.8, 32.7, 1.1) || inCircle(x, y, 38.8, 32.7, 1.1)) return GLINT;
  // Eyes
  if (inCircle(x, y, 24, 34, 3.3) || inCircle(x, y, 40, 34, 3.3)) return ACCENT;
  // Visor interior + border
  if (inRoundRect(x, y, 17.5, 26.5, 29, 15, 6.5)) return VISOR;
  if (inRoundRect(x, y, 16, 25, 32, 18, 7.6)) return STROKE;

  // Chin grille line
  if (inRoundRect(x, y, 25.5, 44.1, 13, 1.8, 0.9)) return STROKE;

  // Head shell (inner fill + subtle bottom bevel shade + outer stroke)
  if (inRoundRect(x, y, 14.5, 20.5, 35, 27, 8.8)) {
    return y > 42.5 ? SHADE : SHELL;
  }
  if (inRoundRect(x, y, 12.2, 18.2, 39.6, 31.6, 10.6)) return STROKE;

  // Side ear caps
  if (inRoundRect(x, y, 9.2, 30, 3.6, 8, 1.4) || inRoundRect(x, y, 51.2, 30, 3.6, 8, 1.4)) return SHADE;
  if (inRoundRect(x, y, 7.6, 28.4, 6.2, 11.2, 2.4) || inRoundRect(x, y, 50.2, 28.4, 6.2, 11.2, 2.4)) return STROKE;

  // Antenna beacon + stalk
  if (inCircle(x, y, 32, 10, 2.6)) return ACCENT;
  if (inCircle(x, y, 32, 10, 4.3)) return STROKE;
  if (inRoundRect(x, y, 30.8, 13.5, 2.4, 6, 1)) return STROKE;

  return BG;
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
