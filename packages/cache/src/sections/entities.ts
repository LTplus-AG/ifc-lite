/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * EntityTable serialization
 */

import type { EntityTable, StringTable } from '@ifc-lite/data';
import { entityTableFromColumns } from '@ifc-lite/data';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';
import { FORMAT_VERSION } from '../types.js';

/**
 * Write EntityTable to buffer
 * Format:
 *   - count: uint32
 *   - expressId: Uint32Array[count]
 *   - typeEnum: Uint16Array[count]
 *   - globalId: Uint32Array[count] (string indices)
 *   - name: Uint32Array[count]
 *   - description: Uint32Array[count]
 *   - objectType: Uint32Array[count]
 *   - flags: Uint8Array[count]
 *   - containedInStorey: Int32Array[count]
 *   - definedByType: Int32Array[count]
 *   - geometryIndex: Int32Array[count]
 *   - typeRangeCount: uint16
 *   - typeRanges: [type:uint16, start:uint32, end:uint32][]
 *   - rawTypeName: Uint32Array[count] (string indices; v15+ only)
 *
 * The typeRanges triples are vestigial on read: `readEntities` derives the
 * spans from the typeEnum column instead, because pre-#3101 caches stored
 * `start + count` here and the format version does not distinguish them.
 * They are still written so the section layout is unchanged.
 *
 * `rawTypeName` is appended AFTER the typeRanges triples rather than beside
 * the other columns so the v14 prefix stays byte-identical; a v15 reader
 * handed a v14 section simply stops where the old section ended.
 */
export function writeEntities(writer: BufferWriter, entities: EntityTable): void {
  const count = entities.count;

  // Write count
  writer.writeUint32(count);

  // Write columnar arrays
  writer.writeTypedArray(entities.expressId);
  writer.writeTypedArray(entities.typeEnum);
  writer.writeTypedArray(entities.globalId);
  writer.writeTypedArray(entities.name);
  writer.writeTypedArray(entities.description);
  writer.writeTypedArray(entities.objectType);
  writer.writeTypedArray(entities.flags);
  writer.writeTypedArray(entities.containedInStorey);
  writer.writeTypedArray(entities.definedByType);
  writer.writeTypedArray(entities.geometryIndex);

  // Write type ranges
  const typeRangeCount = entities.typeRanges.size;
  writer.writeUint16(typeRangeCount);

  for (const [type, range] of entities.typeRanges) {
    writer.writeUint16(type);
    writer.writeUint32(range.start);
    writer.writeUint32(range.end);
  }

  // Raw IFC class names (v15+). Most concrete IFC product classes have no
  // `IfcTypeEnum` member, so without this column `getTypeName` can only
  // answer 'Unknown' for them after a cache load, while the live parser
  // table answers with the real class. A table built without the column
  // (server hydration) writes zeroes, which read back as the empty string
  // and degrade to the same enum-only answer as before.
  const raw = entities.rawTypeName;
  writer.writeTypedArray(raw && raw.length >= count ? raw.subarray(0, count) : new Uint32Array(count));
}

/**
 * Read EntityTable from buffer.
 *
 * `version` is the cache header's FORMAT_VERSION. v15+ sections carry a
 * trailing `rawTypeName` column; older ones stop after the typeRanges
 * triples and must not be read past.
 */
export function readEntities(
  reader: BufferReader,
  strings: StringTable,
  version: number = FORMAT_VERSION,
): EntityTable {
  const count = reader.readUint32();

  // Read columnar arrays
  const expressId = reader.readUint32Array(count);
  const typeEnum = reader.readUint16Array(count);
  const globalId = reader.readUint32Array(count);
  const name = reader.readUint32Array(count);
  const description = reader.readUint32Array(count);
  const objectType = reader.readUint32Array(count);
  const flags = reader.readUint8Array(count);
  const containedInStorey = reader.readInt32Array(count);
  const definedByType = reader.readInt32Array(count);
  const geometryIndex = reader.readInt32Array(count);

  // Read (and discard) the stored type-range triples. The bytes must still be
  // consumed to keep the reader aligned, but their meaning is not trustworthy:
  // caches written before #3101 hold `start + count`, later ones hold a
  // `[firstRow, lastRow + 1]` span, and FORMAT_VERSION was deliberately not
  // bumped (header.ts accepts any version <= FORMAT_VERSION by design), so
  // both vintages arrive here indistinguishable. `entityTableFromColumns`
  // derives the spans from the live typeEnum column instead, which is why
  // `typeRanges` is deliberately left off the columns object below.
  const typeRangeCount = reader.readUint16();

  for (let i = 0; i < typeRangeCount; i++) {
    reader.readUint16(); // type
    reader.readUint32(); // start
    reader.readUint32(); // end (or count, for a pre-#3101 cache)
  }

  // Raw IFC class names, v15+ only (see writeEntities). Left undefined for
  // older sections, where the bytes are simply not there — reading them
  // would consume whatever section follows.
  const rawTypeName = version >= 15 ? reader.readUint32Array(count) : undefined;

  // One shared implementation with the live parser table. Keeping a second
  // copy here is what let the `rawTypeName` fallback go missing from cache
  // loads while the parser had it: every entity of a class absent from
  // `IfcTypeEnum` came back as 'Unknown'.
  return entityTableFromColumns(
    {
      count,
      expressId,
      typeEnum,
      globalId,
      name,
      description,
      objectType,
      flags,
      containedInStorey,
      definedByType,
      geometryIndex,
      rawTypeName,
    },
    strings,
  );
}
