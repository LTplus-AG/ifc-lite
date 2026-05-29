/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CacheEntityIndex, CacheEntityRef, CachedEntityIndexColumns } from '../types.js';
import { BufferReader, BufferWriter } from '../utils/buffer-utils.js';

export function writeEntityIndex(writer: BufferWriter, entityIndex: CacheEntityIndex): void {
  const refs = Array.from(entityIndex.byId, ([id, ref]) => normalizeRef(id, ref))
    .sort((a, b) => a.expressId - b.expressId);

  const typeNameToIndex = new Map<string, number>();
  const typeNames: string[] = [];
  const ids = new Uint32Array(refs.length);
  const byteOffsets = new Uint32Array(refs.length);
  const byteLengths = new Uint32Array(refs.length);
  const typeIndices = new Uint16Array(refs.length);

  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    ids[i] = ref.expressId;
    byteOffsets[i] = ref.byteOffset;
    byteLengths[i] = ref.byteLength;

    let typeIndex = typeNameToIndex.get(ref.type);
    if (typeIndex === undefined) {
      typeIndex = typeNames.length;
      if (typeIndex > 0xffff) {
        throw new Error('Entity index has more than 65535 unique IFC type names');
      }
      typeNameToIndex.set(ref.type, typeIndex);
      typeNames.push(ref.type);
    }
    typeIndices[i] = typeIndex;
  }

  writer.writeUint32(refs.length);
  writer.writeUint32(typeNames.length);
  for (const typeName of typeNames) {
    writer.writeString(typeName);
  }
  writer.writeTypedArray(ids);
  writer.writeTypedArray(byteOffsets);
  writer.writeTypedArray(byteLengths);
  writer.writeTypedArray(typeIndices);
}

export function readEntityIndex(reader: BufferReader): CachedEntityIndexColumns {
  const count = reader.readUint32();
  const typeNameCount = reader.readUint32();
  const typeNames: string[] = [];
  for (let i = 0; i < typeNameCount; i++) {
    typeNames.push(reader.readString());
  }

  const ids = reader.readUint32Array(count);
  const byteOffsets = reader.readUint32Array(count);
  const byteLengths = reader.readUint32Array(count);
  const typeIndices = reader.readUint16Array(count);

  // Fail fast on a corrupt cache: every typeIndex must address a real entry in
  // typeNames, else downstream lookups (typeNames[typeIndices[i]]) silently
  // yield undefined. A throw here is handled by BinaryCacheReader.read()'s
  // caller as a cache miss → re-parse, matching the other validation throws.
  for (let i = 0; i < typeIndices.length; i++) {
    if (typeIndices[i] >= typeNames.length) {
      throw new Error(
        `Corrupt cache entity-index: typeIndex ${typeIndices[i]} at row ${i} ` +
          `exceeds typeNames length ${typeNames.length}`,
      );
    }
  }

  return { ids, byteOffsets, byteLengths, typeIndices, typeNames };
}

function normalizeRef(id: number, ref: CacheEntityRef): CacheEntityRef {
  return {
    expressId: ref.expressId || id,
    type: String(ref.type || '').toUpperCase(),
    byteOffset: ref.byteOffset,
    byteLength: ref.byteLength,
    lineNumber: ref.lineNumber ?? 0,
  };
}
