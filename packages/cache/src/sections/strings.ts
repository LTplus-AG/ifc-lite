/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * StringTable serialization
 */

import { StringTable } from '@ifc-lite/data';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';

/**
 * Write StringTable to buffer
 * Format:
 *   - count: uint32
 *   - offsets: uint32[count+1] (cumulative byte offsets)
 *   - data: concatenated UTF-8 strings
 */
export function writeStrings(writer: BufferWriter, strings: StringTable): void {
  const allStrings = strings.getAll();
  const count = allStrings.length;

  // Encode all strings to UTF-8
  const encoder = new TextEncoder();
  const encoded: Uint8Array[] = allStrings.map((s) => encoder.encode(s));

  // Calculate offsets
  const offsets = new Uint32Array(count + 1);
  let totalBytes = 0;
  for (let i = 0; i < count; i++) {
    offsets[i] = totalBytes;
    totalBytes += encoded[i].length;
  }
  offsets[count] = totalBytes;

  // Write count
  writer.writeUint32(count);

  // Write offsets array
  writer.writeTypedArray(offsets);

  // Write concatenated string data
  for (const bytes of encoded) {
    writer.writeBytes(bytes);
  }
}

/**
 * Read StringTable from buffer
 */
export function readStrings(reader: BufferReader): StringTable {
  const count = reader.readUint32();

  // Read offsets
  const offsets = reader.readUint32Array(count + 1);

  // Read total string data
  const totalBytes = offsets[count];
  const data = reader.readBytes(totalBytes);

  // Decode strings positionally. The writer serialized `getAll()` by index, so
  // the read MUST preserve those indices. The old `intern()` path deduped, so a
  // table that legitimately held a duplicate string (possible via transport's
  // `fromArray`) would collapse the duplicate and shift EVERY later index on
  // reload — silently corrupting all StringTable-indexed lookups. `fromArray`
  // keeps every slot (positions intact); the on-disk shape is unchanged.
  const decoder = new TextDecoder();
  const all: string[] = new Array(count);
  for (let i = 0; i < count; i++) {
    all[i] = decoder.decode(data.subarray(offsets[i], offsets[i + 1]));
  }

  return StringTable.fromArray(all);
}
