/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { inflateRawSync } from 'node:zlib';

/** Extract one named member from a verified ZIP, with an explicit output bound. */
export function extractZipMember(zip, name, maxSize) {
  const endMin = Math.max(0, zip.length - 65_557);
  let end = -1;
  for (let i = zip.length - 22; i >= endMin; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('ZIP end-of-directory record is missing');
  const count = zip.readUInt16LE(end + 10);
  const centralSize = zip.readUInt32LE(end + 12);
  const centralStart = zip.readUInt32LE(end + 16);
  if (count === 0xffff || centralStart === 0xffffffff || centralStart + centralSize > end) {
    throw new Error('ZIP64 or invalid central directory is unsupported');
  }
  let offset = centralStart;
  let found;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('invalid ZIP central-directory entry');
    }
    const fileNameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const next = offset + 46 + fileNameLength + extraLength + commentLength;
    if (next > end) throw new Error('truncated ZIP central-directory entry');
    if (zip.toString('utf8', offset + 46, offset + 46 + fileNameLength) === name) {
      if (found) throw new Error(`duplicate ZIP member: ${name}`);
      found = {
        flags: zip.readUInt16LE(offset + 8),
        method: zip.readUInt16LE(offset + 10),
        compressedSize: zip.readUInt32LE(offset + 20),
        size: zip.readUInt32LE(offset + 24),
        localOffset: zip.readUInt32LE(offset + 42),
      };
    }
    offset = next;
  }
  if (!found) throw new Error(`ZIP member missing: ${name}`);
  if (found.size > maxSize || found.compressedSize === 0xffffffff || found.size === 0xffffffff) {
    throw new Error(`ZIP member exceeds declared size: ${name}`);
  }
  if (found.flags & 1) throw new Error(`encrypted ZIP member is unsupported: ${name}`);
  const local = found.localOffset;
  if (local + 30 > centralStart || zip.readUInt32LE(local) !== 0x04034b50) {
    throw new Error('invalid ZIP local header');
  }
  const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const dataEnd = dataStart + found.compressedSize;
  if (dataEnd > centralStart) throw new Error('ZIP member data exceeds archive bounds');
  const compressed = zip.subarray(dataStart, dataEnd);
  let result;
  if (found.method === 0) result = compressed;
  else if (found.method === 8) result = inflateRawSync(compressed, { maxOutputLength: maxSize });
  else throw new Error(`unsupported ZIP compression method: ${found.method}`);
  if (result.length !== found.size) throw new Error(`ZIP member size mismatch: ${name}`);
  return result;
}
