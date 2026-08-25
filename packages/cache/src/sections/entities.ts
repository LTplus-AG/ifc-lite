/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * EntityTable serialization
 */

import type { EntityTable, StringTable } from '@ifc-lite/data';
import { IfcTypeEnum, IfcTypeEnumToString, IfcTypeEnumFromString, IFC_ENTITY_NAMES } from '@ifc-lite/data';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';

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
 *
 * The typeRanges triples are vestigial on read: `readEntities` derives the
 * spans from the typeEnum column instead, because pre-#3101 caches stored
 * `start + count` here and the format version does not distinguish them.
 * They are still written so the section layout is unchanged.
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
}

/**
 * Read EntityTable from buffer
 */
export function readEntities(reader: BufferReader, strings: StringTable): EntityTable {
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
  // both vintages arrive here indistinguishable. The spans are derived from
  // the live typeEnum column below instead.
  const typeRangeCount = reader.readUint16();

  for (let i = 0; i < typeRangeCount; i++) {
    reader.readUint16(); // type
    reader.readUint32(); // start
    reader.readUint32(); // end (or count, for a pre-#3101 cache)
  }

  // Build EntityTable with methods
  const HAS_GEOMETRY = 0b00000001;

  // Build correct per-type index arrays. Every row of a type is listed, so
  // this survives IFC files that interleave types — unlike the serialized
  // typeRanges, which cannot express more than one contiguous run per type.
  const typeIndices = new Map<IfcTypeEnum, number[]>();
  for (let i = 0; i < count; i++) {
    const t = typeEnum[i] as IfcTypeEnum;
    let arr = typeIndices.get(t);
    if (!arr) {
      arr = [];
      typeIndices.set(t, arr);
    }
    arr.push(i);
  }

  // Derive the spans from the same index arrays, so the one structure that
  // survives interleaving feeds both getByType() and the public typeRanges.
  const typeRanges = new Map<IfcTypeEnum, { start: number; end: number }>();
  for (const [type, indices] of typeIndices) {
    typeRanges.set(type, { start: indices[0], end: indices[indices.length - 1] + 1 });
  }

  // PRE-BUILD INDEX MAP: O(n) once, then O(1) lookups
  // This eliminates O(n²) when getName/hasGeometry are called for every entity
  const idToIndex = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    idToIndex.set(expressId[i], i);
  }

  const indexOfId = (id: number): number => {
    return idToIndex.get(id) ?? -1;
  };

  // Build GlobalId → expressId map for BCF integration
  const globalIdToExpressId = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const gidString = strings.get(globalId[i]);
    if (gidString) {
      globalIdToExpressId.set(gidString, expressId[i]);
    }
  }

  // Additive display-class overrides (UI retype). See entity-table.ts.
  const typeOverrides = new Map<number, string>();

  return {
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
    typeRanges,

    getGlobalId: (id) => {
      const idx = indexOfId(id);
      return idx >= 0 ? strings.get(globalId[idx]) : '';
    },
    getName: (id) => {
      const idx = indexOfId(id);
      return idx >= 0 ? strings.get(name[idx]) : '';
    },
    getDescription: (id) => {
      const idx = indexOfId(id);
      return idx >= 0 ? strings.get(description[idx]) : '';
    },
    getObjectType: (id) => {
      const idx = indexOfId(id);
      return idx >= 0 ? strings.get(objectType[idx]) : '';
    },
    getTypeName: (id) => {
      const override = typeOverrides.get(id);
      if (override !== undefined) return override;
      const idx = indexOfId(id);
      return idx >= 0 ? IfcTypeEnumToString(typeEnum[idx]) : 'Unknown';
    },
    hasGeometry: (id) => {
      const idx = indexOfId(id);
      return idx >= 0 ? (flags[idx] & HAS_GEOMETRY) !== 0 : false;
    },
    getByType: (type) => {
      const indices = typeIndices.get(type);
      if (!indices) return [];
      const ids: number[] = new Array(indices.length);
      for (let i = 0; i < indices.length; i++) {
        ids[i] = expressId[indices[i]];
      }
      return ids;
    },
    getTypeEnum: (id) => {
      const override = typeOverrides.get(id);
      if (override !== undefined) return IfcTypeEnumFromString(override);
      const idx = indexOfId(id);
      return idx >= 0 ? typeEnum[idx] as IfcTypeEnum : IfcTypeEnum.Unknown;
    },
    setTypeOverride: (id, typeName) => {
      if (typeName === null) typeOverrides.delete(id);
      // Canonicalise on the way in, matching `entityTableFromColumns`
      // (packages/data/src/entity-table.ts). `getTypeName` echoes the
      // override back verbatim and consumers like
      // `isSpatialStructureTypeName` match the PascalCase form, so storing
      // the caller's raw UPPERCASE token makes a retyped entity invisible to
      // them. All three EntityTable implementations must agree here.
      else typeOverrides.set(id, IFC_ENTITY_NAMES[typeName.toUpperCase()] ?? typeName.toUpperCase());
    },
    getExpressIdByGlobalId: (gid) => {
      return globalIdToExpressId.get(gid) ?? -1;
    },
  };
}
