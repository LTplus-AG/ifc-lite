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

  return {
    ids: reader.readUint32Array(count),
    byteOffsets: reader.readUint32Array(count),
    byteLengths: reader.readUint32Array(count),
    typeIndices: reader.readUint16Array(count),
    typeNames,
  };
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
