/**
 * Rasterize the Service Runner mark to PNG + ICO with no extra deps.
 * Draws at 256px then box-filters down so the tray sizes stay readable.
 */
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "assets");
const web = join(root, "web");
mkdirSync(assets, { recursive: true });
mkdirSync(web, { recursive: true });

const BG = [14, 20, 27, 255];
const BORDER = [90, 108, 128, 255];
const MINT = [61, 255, 176, 255];
const BLUE = [110, 168, 255, 255];

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function mix(a, b, t) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

function roundedRectSdf(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(ax, ay) - r;
}

function capsuleSdf(x, y, x0, y0, x1, y1, r) {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const len2 = vx * vx + vy * vy || 1;
  let t = ((x - x0) * vx + (y - y0) * vy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x0 + vx * t), y - (y0 + vy * t)) - r;
}

function triangleSdf(px, py, ax, ay, bx, by, cx, cy) {
  const e0x = bx - ax,
    e0y = by - ay;
  const e1x = cx - bx,
    e1y = cy - by;
  const e2x = ax - cx,
    e2y = ay - cy;
  const v0x = px - ax,
    v0y = py - ay;
  const v1x = px - bx,
    v1y = py - by;
  const v2x = px - cx,
    v2y = py - cy;
  const pq0x = v0x - e0x * Math.max(0, Math.min(1, (v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y)));
  const pq0y = v0y - e0y * Math.max(0, Math.min(1, (v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y)));
  const pq1x = v1x - e1x * Math.max(0, Math.min(1, (v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y)));
  const pq1y = v1y - e1y * Math.max(0, Math.min(1, (v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y)));
  const pq2x = v2x - e2x * Math.max(0, Math.min(1, (v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y)));
  const pq2y = v2y - e2y * Math.max(0, Math.min(1, (v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y)));
  const s = Math.sign(e0x * e2y - e0y * e2x);
  const d = Math.min(
    pq0x * pq0x + pq0y * pq0y,
    pq1x * pq1x + pq1y * pq1y,
    pq2x * pq2x + pq2y * pq2y,
  );
  const inside =
    s * (v0x * e0y - v0y * e0x) > 0 &&
    s * (v1x * e1y - v1y * e1x) > 0 &&
    s * (v2x * e2y - v2y * e2x) > 0;
  return (inside ? -1 : 1) * Math.sqrt(d);
}

function cover(sdf) {
  // 1px AA
  return Math.max(0, Math.min(1, 0.5 - sdf));
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const s = size / 256;
  const cx = 128 * s;
  const cy = 128 * s;
  const tileR = 56 * s;
  const hw = 118 * s;
  const hh = 118 * s;
  const bars = [
    { y: 86 * s, w: 118 * s, a: 1 },
    { y: 128 * s, w: 92 * s, a: 0.82 },
    { y: 170 * s, w: 62 * s, a: 0.55 },
  ];
  const barH = 14 * s;
  const barX = 78 * s;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let col = [0, 0, 0, 0];

      const tile = roundedRectSdf(px, py, cx, cy, hw, hh, tileR);
      const tileA = cover(tile);
      if (tileA > 0) col = mix(col, BG, tileA);

      const inner = roundedRectSdf(px, py, cx, cy, hw - 3 * s, hh - 3 * s, tileR - 3 * s);
      const ring = cover(Math.abs(inner + 1.2 * s) - 1.6 * s);
      if (ring > 0) col = mix(col, BORDER, ring * 0.85);

      for (const bar of bars) {
        const d = capsuleSdf(px, py, barX, bar.y, barX + bar.w, bar.y, barH);
        const a = cover(d) * bar.a;
        if (a > 0) col = mix(col, MINT, a);
      }

      // Play chevron — skip on the 16px tray size so bars stay readable.
      if (size >= 24) {
        const tri = triangleSdf(
          px,
          py,
          186 * s,
          108 * s,
          186 * s,
          148 * s,
          218 * s,
          128 * s,
        );
        const a = cover(tri - 0.4);
        if (a > 0) col = mix(col, BLUE, a);
      }

      const i = (y * size + x) * 4;
      rgba[i] = col[0];
      rgba[i + 1] = col[1];
      rgba[i + 2] = col[2];
      rgba[i + 3] = col[3];
    }
  }
  return rgba;
}

function pngAt(size) {
  return encodePng(size, size, draw(size));
}

function icoFromPngs(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6 + 16 * count);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = 6 + 16 * count;
  const parts = [header];
  entries.forEach((e, i) => {
    const o = 6 + 16 * i;
    header[o] = e.size >= 256 ? 0 : e.size;
    header[o + 1] = e.size >= 256 ? 0 : e.size;
    header[o + 2] = 0;
    header[o + 3] = 0;
    header.writeUInt16LE(1, o + 4);
    header.writeUInt16LE(32, o + 6);
    header.writeUInt32LE(e.png.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    parts.push(e.png);
    offset += e.png.length;
  });
  return Buffer.concat(parts);
}

const sizes = [16, 32, 48, 256];
const pngs = sizes.map((size) => ({ size, png: pngAt(size) }));
const png256 = pngs.find((p) => p.size === 256).png;
const ico = icoFromPngs(pngs);

writeFileSync(join(assets, "icon.png"), png256);
writeFileSync(join(assets, "icon.ico"), ico);
writeFileSync(join(web, "icon.png"), png256);
writeFileSync(join(web, "favicon.ico"), ico);

const hash = createHash("sha1").update(png256).digest("hex").slice(0, 8);
console.log(`icons written (${hash}) → assets/icon.png, assets/icon.ico, web/`);
