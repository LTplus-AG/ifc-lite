/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Header serialization
 */

import {
  MAGIC,
  FORMAT_VERSION,
  HEADER_SIZE,
  SECTION_ENTRY_SIZE,
  type CacheHeader,
  type SectionEntry,
  type CacheHeaderInfo,
  HeaderFlags,
  SectionFlags,
} from '../types.js';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';

/**
 * Write header and section table
 */
export function writeHeader(
  writer: BufferWriter,
  header: CacheHeader,
  sections: SectionEntry[]
): void {
  // Magic
  writer.writeUint32(MAGIC);

  // Version
  writer.writeUint16(header.version);

  // Flags
  writer.writeUint16(header.flags);

  // Source hash
  writer.writeBigUint64(header.sourceHash);

  // Schema
  writer.writeUint8(header.schema);

  // Counts
  writer.writeUint32(header.entityCount);
  writer.writeUint32(header.totalVertices);
  writer.writeUint32(header.totalTriangles);

  // Section count
  writer.writeUint16(sections.length);

  // Padding to 64 bytes
  // Already written: 4 + 2 + 2 + 8 + 1 + 4 + 4 + 4 + 2 = 31 bytes
  const padding = HEADER_SIZE - 31;
  for (let i = 0; i < padding; i++) {
    writer.writeUint8(0);
  }

  // Write section table
  for (const section of sections) {
    writer.writeUint16(section.type);
    writer.writeUint16(section.flags);
    writer.writeUint32(section.offset);
    writer.writeUint32(section.size);
    writer.writeUint32(section.compressedSize);
  }
}

/**
 * Read header and section table
 */
export function readHeader(reader: BufferReader): CacheHeaderInfo {
  // Magic
  const magic = reader.readUint32();
  if (magic !== MAGIC) {
    throw new Error(`Invalid magic bytes: expected 0x${MAGIC.toString(16)}, got 0x${magic.toString(16)}`);
  }

  // Version
  const version = reader.readUint16();
  if (version > FORMAT_VERSION) {
    throw new Error(`Unsupported format version: ${version} (max supported: ${FORMAT_VERSION})`);
  }

  // Flags
  const flags = reader.readUint16() as HeaderFlags;

  // Source hash
  const sourceHash = reader.readBigUint64();

  // Schema
  const schema = reader.readUint8();

  // Counts
  const entityCount = reader.readUint32();
  const totalVertices = reader.readUint32();
  const totalTriangles = reader.readUint32();

  // Section count
  const sectionCount = reader.readUint16();

  // Skip padding
  const padding = HEADER_SIZE - 31;
  reader.skip(padding);

  // Read section table
  const sections: SectionEntry[] = [];
  for (let i = 0; i < sectionCount; i++) {
    sections.push({
      type: reader.readUint16(),
      flags: reader.readUint16() as SectionFlags,
      offset: reader.readUint32(),
      size: reader.readUint32(),
      compressedSize: reader.readUint32(),
    });
  }

  return {
    version,
    schema,
    sourceHash,
    hasSourceHash: (flags & HeaderFlags.SourceHashUnset) === 0,
    entityCount,
    totalVertices,
    totalTriangles,
    hasGeometry: (flags & HeaderFlags.HasGeometry) !== 0,
    hasSpatialHierarchy: (flags & HeaderFlags.HasSpatial) !== 0,
    sections,
  };
}
