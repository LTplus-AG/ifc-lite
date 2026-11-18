/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { deflateSync } from 'node:zlib';
/** A valid, noisy 512² RGBA PNG; actual image bytes exceed the 1MiB tool envelope after base64. */
export function largePng() {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const end = Buffer.alloc(4); end.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, body, end]);
  };
  const pixels = Buffer.alloc(512 * (512 * 4 + 1)); let random = 321;
  for (let row = 0; row < 512; row++) for (let x = 1; x <= 512 * 4; x++) { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; pixels[row * 2049 + x] = random >>> 24; }
  const header = Buffer.alloc(13); header.writeUInt32BE(512, 0); header.writeUInt32BE(512, 4); header[8] = 8; header[9] = 6;
  return `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', new Uint8Array())]).toString('base64')}`;
}
