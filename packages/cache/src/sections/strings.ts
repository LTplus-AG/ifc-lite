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

  // Validate the offset table BEFORE slicing. `data.subarray(offsets[i],
  // offsets[i + 1])` SATURATES instead of throwing, so a corrupt/non-monotonic
  // entry doesn't fail — it silently makes one string absorb bytes that
  // belong to the next one (or produces an empty string), the same
  // "declared length trusted without a bounds check" shape that bit the
  // packed-geometry pool ranges and the LAS strided read. A writer always
  // produces a non-decreasing sequence ending at `totalBytes`, so requiring
  // monotonicity here rejects only corruption, never a legitimate table.
  // Anchor the sequence before checking it is monotonic. The loop below
  // compares each offset with its PREDECESSOR, and offset 0 has none -- so a
  // table whose every offset is shifted by the same amount stays perfectly
  // monotonic and passes while every string is read from the wrong place.
  // The external anchor here is literal zero: the writer emits the first
  // string at the start of the data blob.
  // No `count > 0` guard here: the offsets array always has count+1
  // elements (even for count === 0, a legitimate empty table still writes
  // one element, offsets[0] === totalBytes === 0). Skipping the check when
  // count is 0 let a corrupt file set offsets[0] to an arbitrary value,
  // which flows unchecked into `totalBytes = offsets[count]` below and gets
  // handed to `reader.readBytes(totalBytes)` -- silently consuming that many
  // bytes of whatever data follows (e.g. the next cache section) as if it
  // were this (nonexistent) table's string data, desyncing every read after
  // it, with no error at all.
  if (offsets[0] !== 0) {
    throw new Error(
      `Corrupt cache StringTable: first offset is ${offsets[0]}, expected 0`,
    );
  }
  for (let i = 0; i < count; i++) {
    if (offsets[i] > offsets[i + 1]) {
      throw new Error(
        `Corrupt cache StringTable: offset[${i}]=${offsets[i]} exceeds offset[${i + 1}]=${offsets[i + 1]}`,
      );
    }
  }

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
