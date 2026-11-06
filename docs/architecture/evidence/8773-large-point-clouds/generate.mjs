/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Writes a synthetic LAS (format 2) or binary PLY point grid.
// Usage: node generate.mjs las|ply <out> <points>
import { openSync, writeSync, closeSync } from 'node:fs';
const [kind, out, nStr] = process.argv.slice(2);
const n = Number(nStr);
const fd = openSync(out, 'w');
const xyz = (i) => [i % 10000, Math.floor(i / 10000) % 10000, Math.floor(i / 1e8)];
const BATCH = 1 << 21;
if (kind === 'las') {
  const rec = 26, hs = 227, h = Buffer.alloc(hs);
  h.write('LASF', 0); h.writeUInt8(1, 24); h.writeUInt8(2, 25);
  h.writeUInt16LE(hs, 94); h.writeUInt32LE(hs, 96); h.writeUInt32LE(0, 100);
  h.writeUInt8(2, 104); h.writeUInt16LE(rec, 105); h.writeUInt32LE(n, 107);
  for (const [o, v] of [[131, 0.01], [139, 0.01], [147, 0.01], [155, 0], [163, 0], [171, 0]]) h.writeDoubleLE(v, o);
  const last = xyz(n - 1);
  for (const [o, v] of [[179, 99.99], [187, 0], [195, 99.99], [203, 0], [211, last[2] / 100], [219, 0]]) h.writeDoubleLE(v, o);
  writeSync(fd, h);
  for (let s = 0; s < n; s += BATCH) {
    const c = Math.min(BATCH, n - s), b = Buffer.alloc(c * rec);
    for (let k = 0; k < c; k++) { const [x, y, z] = xyz(s + k), o = k * rec;
      b.writeInt32LE(x, o); b.writeInt32LE(y, o + 4); b.writeInt32LE(z, o + 8);
      b.writeUInt16LE((x * 6) & 0xffff, o + 20); b.writeUInt16LE((y * 6) & 0xffff, o + 22); b.writeUInt16LE(32768, o + 24); }
    writeSync(fd, b);
  }
} else {
  writeSync(fd, Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`));
  const rec = 15;
  for (let s = 0; s < n; s += BATCH) {
    const c = Math.min(BATCH, n - s), b = Buffer.alloc(c * rec);
    for (let k = 0; k < c; k++) { const [x, y, z] = xyz(s + k), o = k * rec;
      b.writeFloatLE(x / 100, o); b.writeFloatLE(y / 100, o + 4); b.writeFloatLE(z, o + 8);
      b[o + 12] = x & 255; b[o + 13] = y & 255; b[o + 14] = 128; }
    writeSync(fd, b);
  }
}
closeSync(fd);
