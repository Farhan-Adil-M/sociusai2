// generate.mjs — builds the extension's PNG icons with zero dependencies.
//
// Design: a rounded square in Socius blue (#1D4ED8) with a white, pixel-art
// "S" glyph (7x7 grid) centered on top. The grid cell is size/8, so at 16px
// each cell is 2px and the grid sits with 1px padding on each side.
//
// The PNGs are written by hand: signature + IHDR + IDAT (zlib-deflated raw
// RGBA scanlines) + IEND, with CRC32 implemented locally. Run:
//
//   node extension/icons/generate.mjs

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 48, 128];
const BLUE = [29, 78, 216, 255]; // #1D4ED8 — Socius blue
const WHITE = [255, 255, 255, 255];

// 7x7 pixel-art "S". 1 = white glyph pixel.
const S_GRID = [
  [0, 1, 1, 1, 1, 1, 0],
  [1, 1, 0, 0, 0, 0, 0],
  [1, 1, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 0, 0, 0, 0, 1, 1],
  [0, 0, 0, 0, 0, 1, 1],
  [0, 1, 1, 1, 1, 1, 0],
];

/* --------------------------------------------------------------- CRC32 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ----------------------------------------------------------- PNG chunks */

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // bytes 10-12: compression 0, filter 0, interlace 0

  const stride = size * 4 + 1; // filter byte + RGBA row
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- rendering */

function inRoundedRect(x, y, size, radius) {
  const max = size - 1;
  if (x >= radius && x <= max - radius) return true;
  if (y >= radius && y <= max - radius) return true;
  const cx = x < radius ? radius : max - radius;
  const cy = y < radius ? radius : max - radius;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cell = Math.floor(size / 8);
  const grid = cell * 7;
  const offset = Math.floor((size - grid) / 2);
  const radius = Math.max(2, Math.round(size * 0.18));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inRoundedRect(x, y, size, radius)) continue; // transparent corner
      const gx = Math.floor((x - offset) / cell);
      const gy = Math.floor((y - offset) / cell);
      const on = gx >= 0 && gx < 7 && gy >= 0 && gy < 7 && S_GRID[gy][gx] === 1;
      const color = on ? WHITE : BLUE;
      const i = (y * size + x) * 4;
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = color[3];
    }
  }
  return rgba;
}

/* ------------------------------------------------------------------ main */

for (const size of SIZES) {
  const png = encodePng(size, renderIcon(size));
  const url = new URL('icon' + size + '.png', import.meta.url);
  writeFileSync(url, png);
  console.log('wrote', url.pathname, png.length, 'bytes');
}
