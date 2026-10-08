// Renders the Halo logo (a ring with a spark in its gap) to PNG without any
// image dependency. Produces menu-bar template icons and a colour app icon.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
mkdirSync(out, { recursive: true });

// ---- minimal PNG encoder -------------------------------------------------
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- logo geometry (normalised to a 24x24 box, matches src/renderer/logo.js)
// ring: centre (12,12) radius 9.2, stroke 2.6 ; gap centred at -45deg (top-right), 70deg wide
// spark: filled dot radius 2.1 sitting on the ring at the gap centre
const GAP_CENTER = -Math.PI / 4, GAP_HALF = (70 / 2) * Math.PI / 180;
function coverage(px, py) {
  const dx = px - 12, dy = py - 12;
  const d = Math.hypot(dx, dy);
  let a = Math.atan2(dy, dx);
  let delta = Math.abs(((a - GAP_CENTER + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
  const inRing = Math.abs(d - 9.2) <= 1.3 && delta > GAP_HALF;
  // round caps at the gap ends
  const capA = GAP_CENTER + GAP_HALF, capB = GAP_CENTER - GAP_HALF;
  const cap = (ang) => Math.hypot(px - (12 + 9.2 * Math.cos(ang)), py - (12 + 9.2 * Math.sin(ang))) <= 1.3;
  const sx = 12 + 9.2 * Math.cos(GAP_CENTER), sy = 12 + 9.2 * Math.sin(GAP_CENTER);
  const spark = Math.hypot(px - sx, py - sy) <= 2.1;
  return inRing || cap(capA) || cap(capB) || spark ? 1 : 0;
}
function raster(size, colorAt) {
  const ss = 4, buf = Buffer.alloc(size * size * 4);
  const pad = size * 0.08;
  const scale = (size - pad * 2) / 24;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let cov = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const px = (x + (sx + 0.5) / ss - pad) / scale, py = (y + (sy + 0.5) / ss - pad) / scale;
      cov += coverage(px, py);
    }
    cov /= ss * ss;
    const [r, g, b] = colorAt(x / size, y / size);
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = Math.round(cov * 255);
  }
  return buf;
}
function roundedBg(size, radiusFrac, inner) {
  // dark glass tile behind the colour logo for the app icon
  const buf = Buffer.alloc(size * size * 4), r = size * radiusFrac;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const cx = Math.max(r, Math.min(size - r, x + 0.5)), cy = Math.max(r, Math.min(size - r, y + 0.5));
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    const a = Math.max(0, Math.min(1, r - d + 0.5));
    const t = y / size;
    const bg = [Math.round(22 + 10 * (1 - t)), Math.round(24 + 10 * (1 - t)), Math.round(34 + 14 * (1 - t))];
    const i = (y * size + x) * 4;
    const ia = inner[i + 3] / 255;
    buf[i] = Math.round(bg[0] * (1 - ia) + inner[i] * ia);
    buf[i + 1] = Math.round(bg[1] * (1 - ia) + inner[i + 1] * ia);
    buf[i + 2] = Math.round(bg[2] * (1 - ia) + inner[i + 2] * ia);
    buf[i + 3] = Math.round(a * 255);
  }
  return buf;
}
const mono = () => [0, 0, 0];
const gradient = (u, v) => { // brushed silver: graphite -> white, diagonal
  const t = Math.max(0, Math.min(1, (u + (1 - v)) / 2));
  const g = Math.round(150 + (255 - 150) * t);
  return [g, g, Math.min(255, g + 2)];
};

writeFileSync(join(out, 'trayTemplate.png'), png(18, 18, raster(18, mono)));
writeFileSync(join(out, 'trayTemplate@2x.png'), png(36, 36, raster(36, mono)));
const big = 512, inner = raster(big, gradient);
writeFileSync(join(out, 'icon.png'), png(big, big, roundedBg(big, 0.22, inner)));
console.log('icons written to', out);
