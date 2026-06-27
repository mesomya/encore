// Generates the toolbar/store icons with zero dependencies: render a rounded
// blue tile with a white circular "replay" arrow at 4x, box-downsample for
// antialiasing, then hand-encode PNG (IHDR/IDAT/IEND + CRC).
// Run: node tools/make-icons.mjs
import zlib from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
mkdirSync(OUT, { recursive: true });

const C0 = [29, 155, 240]; // #1d9bf0
const C1 = [10, 108, 255]; // #0a6cff
const lerp = (a, b, t) => a + (b - a) * t;

// Coverage helpers on a normalized [0,1] canvas ------------------------------
function roundedRectCover(x, y, r) {
  // tile occupies the full [0,1] square with corner radius r
  const dx = Math.min(x, 1 - x);
  const dy = Math.min(y, 1 - y);
  if (dx >= r || dy >= r) return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? 1 : 0;
  const ddx = r - dx;
  const ddy = r - dy;
  return ddx * ddx + ddy * ddy <= r * r ? 1 : 0;
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  const s = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / d;
  const t = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / d;
  return s >= 0 && t >= 0 && s + t <= 1;
}

function replayInside(x, y) {
  // a circular arrow (refresh / "bring it back around") with a gap + arrowhead
  const cx = 0.5, cy = 0.51;
  const dx = x - cx, dy = y - cy;
  const dist = Math.hypot(dx, dy);
  const R = 0.205, t = 0.057; // ring radius + half thickness
  const ang = Math.atan2(dy, dx); // 0=east, +=clockwise (screen y is down)

  // Ring everywhere except an opening at the top (north → north-east),
  // where the arrowhead lives.
  const onRing = Math.abs(dist - R) <= t;
  const inGap = ang > -Math.PI / 2 - 0.12 && ang < -0.18;
  if (onRing && !inGap) return true;

  // Arrowhead: a triangle at the north end of the ring, pointing east
  // (clockwise), so the whole mark reads as rotating.
  const tipx = 0.5 + 0.115, tipy = 0.305;
  if (inTriangle(x, y, 0.5, 0.305 - 0.092, 0.5, 0.305 + 0.092, tipx, tipy)) return true;
  return false;
}

function render(size) {
  const SS = 4;
  const R = size * SS;
  const buf = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (px * SS + sx + 0.5) / R;
          const fy = (py * SS + sy + 0.5) / R;
          const tile = roundedRectCover(fx, fy, 0.235);
          if (!tile) continue;
          let cr = lerp(C0[0], C1[0], (fx + fy) / 2);
          let cg = lerp(C0[1], C1[1], (fx + fy) / 2);
          let cb = lerp(C0[2], C1[2], (fx + fy) / 2);
          if (replayInside(fx, fy)) {
            cr = 255;
            cg = 255;
            cb = 255;
          }
          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      buf[i] = Math.round(r / n);
      buf[i + 1] = Math.round(g / n);
      buf[i + 2] = Math.round(b / n);
      buf[i + 3] = Math.round(a / n);
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
