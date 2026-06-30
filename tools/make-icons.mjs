// Generates transparent Refeed icons with zero dependencies.
//
// The mark is intentionally simple: a single X-blue bookmark glyph on a
// transparent canvas. Chrome/Edge render it cleanly in the toolbar, and the
// Web Store can place it on any background.
//
// Run: node tools/make-icons.mjs
import zlib from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
mkdirSync(OUT, { recursive: true });

const BLUE = [29, 155, 240]; // X blue, #1d9bf0

function clamp(v, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, v));
}

function roundedRectSdf(x, y, cx, cy, w, h, r) {
  const qx = Math.abs(x - cx) - w / 2 + r;
  const qy = Math.abs(y - cy) - h / 2 + r;
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  const s = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / d;
  const t = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / d;
  return s >= 0 && t >= 0 && s + t <= 1;
}

function bookmarkCoverage(x, y, scale) {
  // Body: slightly rounded top corners, straight sides, centered bookmark notch.
  // Coordinates are normalized to [0,1].
  const left = 0.285;
  const right = 0.715;
  const top = 0.145;
  const bottom = 0.855;
  const notchY = 0.655;
  const notchHalf = 0.105;
  const radius = 0.055;

  // Rounded rectangle body up to the notch shoulders.
  const body = roundedRectSdf(
    x,
    y,
    (left + right) / 2,
    (top + notchY) / 2,
    right - left,
    notchY - top,
    radius,
  );

  // Two tails below the shoulders.
  const leftTail =
    x >= left &&
    x <= 0.5 &&
    y >= notchY - 0.01 &&
    y <= bottom &&
    inTriangle(x, y, left, notchY - 0.01, 0.5, bottom, 0.5 - notchHalf, notchY - 0.01);
  const rightTail =
    x >= 0.5 &&
    x <= right &&
    y >= notchY - 0.01 &&
    y <= bottom &&
    inTriangle(x, y, right, notchY - 0.01, 0.5, bottom, 0.5 + notchHalf, notchY - 0.01);

  const aa = 1.5 / scale;
  const bodyCov = clamp(0.5 - body / aa);
  return Math.max(bodyCov, leftTail ? 1 : 0, rightTail ? 1 : 0);
}

function render(size) {
  const SS = 4;
  const R = size * SS;
  const buf = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (px * SS + sx + 0.5) / R;
          const fy = (py * SS + sy + 0.5) / R;
          a += bookmarkCoverage(fx, fy, R);
        }
      }
      a /= SS * SS;
      const i = (py * size + px) * 4;
      buf[i] = BLUE[0];
      buf[i + 1] = BLUE[1];
      buf[i + 2] = BLUE[2];
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

// PNG encoding ---------------------------------------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function u32(n) {
  return Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const body = Buffer.concat([t, data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
}
function encodePNG(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba
      .subarray(y * size * 4, (y + 1) * size * 4)
      .forEach((v, i) => (raw[y * (size * 4 + 1) + 1 + i] = v));
  }
  const ihdr = Buffer.concat([u32(size), u32(size), Buffer.from([8, 6, 0, 0, 0])]);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(render(size), size);
  writeFileSync(join(OUT, `icon-${size}.png`), png);
  console.log(`icon-${size}.png  (${png.length} bytes)`);
}
