/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pixels for the flag-on qualification (`flag-qualify.mjs`): a minimal PNG
 * codec for renderer readbacks (8-bit RGB/RGBA, what a canvas encodes), the
 * per-pixel statistics of the pixel gate and the diff image.
 */

import { deflateSync, inflateSync } from 'node:zlib';

/**
 * Per-pixel comparison of two RGBA buffers of one size. `threshold` is the
 * largest channel difference still counted as equal (8/255 by default, the
 * campaign's method). Isolated pixels (no differing 4-neighbour) are counted
 * apart: depth-tie noise is isolated, a real difference forms regions.
 */
export function pixelStats(a, b, width, height, { threshold = 8 } = {}) {
  if (a.length !== b.length || a.length !== width * height * 4) throw new Error('pixel buffers differ in size');
  const over = new Uint8Array(width * height);
  let differing = 0, count = 0, max = 0;
  for (let i = 0, p = 0; p < over.length; i += 4, p++) {
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
    if (d) differing++;
    if (d > max) max = d;
    if (d > threshold) { over[p] = 1; count++; }
  }
  let isolated = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x;
    if (!over[p]) continue;
    const near = (x > 0 && over[p - 1]) || (x < width - 1 && over[p + 1]) || (y > 0 && over[p - width]) || (y < height - 1 && over[p + width]);
    if (!near) isolated++;
  }
  const pixels = width * height;
  return { pixels, differing, over: count, overPct: +(100 * count / pixels).toFixed(4), isolatedPct: count ? +(100 * isolated / count).toFixed(1) : 0, max };
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Decode an 8-bit, non-interlaced RGB or RGBA PNG (what a canvas encodes) to RGBA. */
export function decodePng(bytes) {
  const buf = Buffer.from(bytes);
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let width = 0, height = 0, channels = 0;
  const idat = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      channels = { 2: 3, 6: 4 }[data[9]] ?? 0;
      if (data[8] !== 8 || !channels || data[12] !== 0) throw new Error('unsupported PNG (need 8-bit RGB/RGBA, not interlaced)');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * channels, rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride), line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0, up = prev[x], corner = x >= channels ? prev[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      line[x] = (src[x] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) rgba[o + c] = line[x * channels + c];
      rgba[o + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    [prev, line] = [line, prev];
  }
  return { width, height, data: rgba };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Encode RGBA as an 8-bit PNG (filter 0): the diff images. */
export function encodePng({ width, height, data }) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const chunk = (type, body) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([head, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** `a` dimmed with every pixel over the threshold in red: where two frames differ. */
export function diffImage(a, b, { threshold = 8 } = {}) {
  const data = new Uint8Array(a.data.length);
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
    if (d > threshold) { data[i] = 255; data[i + 1] = 0; data[i + 2] = 0; }
    else for (let c = 0; c < 3; c++) data[i + c] = a.data[i + c] * 0.35;
    data[i + 3] = 255;
  }
  return { width: a.width, height: a.height, data };
}

/** Pixel statistics of two PNG files' bytes; `null` stats when the sizes differ. */
export function comparePngs(aBytes, bBytes, options) {
  return compareImages(decodePng(aBytes), decodePng(bBytes), options);
}

/** Pixel statistics of two decoded images; `null` stats when the sizes differ. */
export function compareImages(a, b, options) {
  if (a.width !== b.width || a.height !== b.height) return { a, b, stats: null, sizeMismatch: [a.width, a.height, b.width, b.height] };
  return { a, b, stats: pixelStats(a.data, b.data, a.width, a.height, options) };
}
