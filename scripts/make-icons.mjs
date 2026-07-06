#!/usr/bin/env node
// make-icons.mjs: render the Murmur PWA icon set to web/public/icons/ with no
// image dependencies (raw pixel math + hand-rolled PNG encoding over zlib).
// The art matches the in-app mark: a rounded square with the blue->indigo->
// violet diagonal gradient, carrying a white "murmur" glyph (a dot radiating
// two arcs, the pager signal). Outputs are committed; rerun after art changes.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "public", "icons");
mkdirSync(OUT, { recursive: true });

// --- PNG encoding -------------------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array of size*size*4. */
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // color type RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy
      ? rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
      : raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- art ------------------------------------------------------------------------

// Gradient stops, matching tailwind's blue-500 / indigo-500 / violet-500.
const STOPS = [
  [59, 130, 246],
  [99, 102, 241],
  [139, 92, 246],
];

function gradientAt(t) {
  const seg = t < 0.5 ? [STOPS[0], STOPS[1], t * 2] : [STOPS[1], STOPS[2], (t - 0.5) * 2];
  const [a, b, u] = seg;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

// Coverage of the glyph at unit coordinates (0..1, y down): a dot low-left
// with two arcs radiating toward the upper right.
function glyphAt(ux, uy) {
  const cx = 0.36;
  const cy = 0.64;
  const dx = ux - cx;
  const dy = cy - uy; // flip so positive = up
  const dist = Math.hypot(dx, dy);
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  const soft = (edge, value, w) => Math.max(0, Math.min(1, (edge - value) / w + 0.5));
  const aa = 0.006; // edge softness in unit space (~3px at 512)
  // Filled dot.
  let cov = soft(0.085, dist, aa);
  // Two arcs, clipped to the up-right quadrant (with a little overshoot).
  if (angle >= -18 && angle <= 108) {
    for (const r of [0.21, 0.34]) {
      cov = Math.max(cov, soft(0.03, Math.abs(dist - r), aa));
    }
  }
  return cov;
}

/**
 * Render one icon.
 *  - rounded: corner radius as a fraction of size (0 = full bleed square)
 *  - inset: art scale-down for maskable safe zones (0 = none)
 *  - mono: white glyph on transparency (Android badge) instead of gradient art
 */
function render(size, { rounded = 0.22, inset = 0, mono = false } = {}) {
  const px = Buffer.alloc(size * size * 4);
  const ss = 2; // 2x2 supersampling
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          let ux = (x + (sx + 0.5) / ss) / size;
          let uy = (y + (sy + 0.5) / ss) / size;
          if (mono) {
            const cov = glyphAt(ux, uy);
            r += 255 * cov;
            g += 255 * cov;
            b += 255 * cov;
            a += 255 * cov;
            continue;
          }
          // Maskable variants shrink the art toward the center so platform
          // masks (circles, squircles) never clip the glyph.
          if (inset > 0) {
            ux = (ux - 0.5) / (1 - inset) + 0.5;
            uy = (uy - 0.5) / (1 - inset) + 0.5;
          }
          const inCanvas = ux >= 0 && ux <= 1 && uy >= 0 && uy <= 1;
          // Rounded-rect coverage.
          let shape = 0;
          if (inCanvas) {
            if (rounded <= 0) {
              shape = 1;
            } else {
              const rad = rounded;
              const qx = Math.max(rad - ux, ux - (1 - rad), 0);
              const qy = Math.max(rad - uy, uy - (1 - rad), 0);
              shape = Math.hypot(qx, qy) <= rad ? 1 : 0;
            }
          }
          if (shape === 0 && inset > 0) {
            // Outside the inset art but inside the canvas: maskable icons
            // must be fully opaque, so extend the gradient to the edge.
            const t = ((x + 0.5) / size + (y + 0.5) / size) / 2;
            const [gr, gg, gb] = gradientAt(t);
            r += gr;
            g += gg;
            b += gb;
            a += 255;
            continue;
          }
          if (shape === 0) continue;
          const t = (ux + uy) / 2;
          const [gr, gg, gb] = gradientAt(t);
          const cov = glyphAt(ux, uy);
          r += gr + (255 - gr) * cov;
          g += gg + (255 - gg) * cov;
          b += gb + (255 - gb) * cov;
          a += 255;
        }
      }
      const n = ss * ss;
      const i = (y * size + x) * 4;
      px[i] = Math.round(r / n);
      px[i + 1] = Math.round(g / n);
      px[i + 2] = Math.round(b / n);
      px[i + 3] = Math.round(a / n);
    }
  }
  return encodePng(size, px);
}

const outputs = [
  ["icon-192.png", render(192)],
  ["icon-512.png", render(512)],
  // Maskable: full-bleed background, art inset to the ~80% safe zone.
  ["icon-maskable-512.png", render(512, { rounded: 0.22, inset: 0.2 })],
  // iOS applies its own corner mask, so the touch icon is full bleed.
  ["apple-touch-icon-180.png", render(180, { rounded: 0 })],
  // Android notification badge: white-on-transparent alpha mask.
  ["badge-72.png", render(72, { mono: true })],
];

for (const [name, bytes] of outputs) {
  writeFileSync(join(OUT, name), bytes);
  console.log(`wrote ${name} (${bytes.length} bytes)`);
}
