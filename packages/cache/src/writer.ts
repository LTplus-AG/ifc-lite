/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * BinaryCacheWriter - writes .ifc-lite binary cache files
 */

import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import {
  FORMAT_VERSION,
  HEADER_SIZE,
  SECTION_ENTRY_SIZE,
  SectionType,
  HeaderFlags,
  SectionFlags,
  type CacheHeader,
  type SectionEntry,
  type CacheWriteOptions,
  type CacheDataStore,
} from './types.js';
import { BufferWriter } from './utils/buffer-utils.js';
import { xxhash64 } from './utils/hash.js';
import { writeHeader } from './sections/header.js';
import { writeStrings } from './sections/strings.js';
import { writeEntities } from './sections/entities.js';
import { writeProperties } from './sections/properties.js';
import { writeQuantities } from './sections/quantities.js';
import { writeRelationships } from './sections/relationships.js';
import { buildGeometrySectionV13 } from './sections/geometry-chunks.js';
import { writeInstancedShards } from './sections/instanced-shards.js';
import { writeEntityIndex } from './sections/entity-index.js';

export interface GeometryData {
  meshes: MeshData[];
  totalVertices: number;
  totalTriangles: number;
  coordinateInfo: CoordinateInfo;
  /** Raw IFNS GPU-instancing shard bytes (opaque repeated occurrences). Persisted so
   *  a cache reload re-uploads them via the instanced path; the flat `meshes` above
   *  deliberately excludes these occurrences. Empty/absent for non-instanced models. */
  instancedShards?: ArrayBuffer[];
}

export class BinaryCacheWriter {
  /**
   * Write a complete cache file
   * @param dataStore - The parsed IFC data store
   * @param geometry - Optional geometry data
   * @param sourceBuffer - Original IFC buffer (for hash)
   * @param options - Write options
   * @returns ArrayBuffer containing the binary cache
   */
  async write(
    dataStore: CacheDataStore,
    geometry: GeometryData | undefined,
    sourceBuffer: ArrayBuffer,
    options: CacheWriteOptions = {}
  ): Promise<ArrayBuffer> {
    const {
      includeGeometry = true,
      omitSourceHash = false,
    } = options;

    // Source hash: `omitSourceHash` skips the full-file main-thread `xxhash64`
    // for large sources (the caller validates the source another way and flags
    // the header as unset); otherwise hash the whole buffer as before.
    const sourceHash = omitSourceHash ? 0n : xxhash64(sourceBuffer);

    // Build sections
    const sectionBuffers: Array<{ type: SectionType; buffer: ArrayBuffer }> = [];

    // Strings section (always required)
    const stringsBuffer = this.writeSection(() => {
      const writer = new BufferWriter();
      writeStrings(writer, dataStore.strings);
      return writer.build();
    });
    sectionBuffers.push({ type: SectionType.Strings, buffer: stringsBuffer });

    // Entities section
    const entitiesBuffer = this.writeSection(() => {
      const writer = new BufferWriter();
      writeEntities(writer, dataStore.entities);
      return writer.build();
    });
    sectionBuffers.push({ type: SectionType.Entities, buffer: entitiesBuffer });

    // Properties section
    const propertiesBuffer = this.writeSection(() => {
      const writer = new BufferWriter();
      writeProperties(writer, dataStore.properties);
      return writer.build();
    });
    sectionBuffers.push({ type: SectionType.Properties, buffer: propertiesBuffer });

    // Quantities section
    const quantitiesBuffer = this.writeSection(() => {
      const writer = new BufferWriter();
      writeQuantities(writer, dataStore.quantities);
      return writer.build();
    });
    sectionBuffers.push({ type: SectionType.Quantities, buffer: quantitiesBuffer });

    // Relationships section
    const relationshipsBuffer = this.writeSection(() => {
      const writer = new BufferWriter();
      writeRelationships(writer, dataStore.relationships);
      return writer.build();
    });
    sectionBuffers.push({ type: SectionType.Relationships, buffer: relationshipsBuffer });

    if (dataStore.entityIndex) {
      const entityIndexBuffer = this.writeSection(() => {
        const writer = new BufferWriter();
        writeEntityIndex(writer, dataStore.entityIndex!);
        return writer.build();
      });
      sectionBuffers.push({ type: SectionType.EntityIndex, buffer: entityIndexBuffer });
    }

    // Geometry section (optional)
    let totalVertices = 0;
    let totalTriangles = 0;

    if (includeGeometry && geometry) {
      // v13: chunked geometry section (spatially coherent, per-chunk
      // deflate-raw). The pre-v13 sequential writer was removed — this is
      // the only geometry serializer.
      const geometryBuffer = await buildGeometrySectionV13(
        geometry.meshes,
        geometry.coordinateInfo,
        { compress: options.compressGeometryChunks ?? true }
      );
      sectionBuffers.push({ type: SectionType.Geometry, buffer: geometryBuffer });
      totalVertices = geometry.totalVertices;
      totalTriangles = geometry.totalTriangles;

      // InstancedShards section (optional) — GPU-instanced occurrences live here, not
      // in the flat geometry section, so persist them or a reload drops them.
      if (geometry.instancedShards && geometry.instancedShards.length > 0) {
        const shardsBuffer = this.writeSection(() => {
          const writer = new BufferWriter();
          writeInstancedShards(writer, geometry.instancedShards!);
          return writer.build();
        });
        sectionBuffers.push({ type: SectionType.InstancedShards, buffer: shardsBuffer });
      }
    }

    // Calculate offsets
    const sectionTableSize = sectionBuffers.length * SECTION_ENTRY_SIZE;
    let currentOffset = HEADER_SIZE + sectionTableSize;

    const sections: SectionEntry[] = sectionBuffers.map(({ type, buffer }) => {
      const entry: SectionEntry = {
        type,
        flags: SectionFlags.None,
        offset: currentOffset,
        size: buffer.byteLength,
        compressedSize: 0,
      };
      currentOffset += buffer.byteLength;
      return entry;
    });

    // Build header flags
    let headerFlags = HeaderFlags.None;
    if (includeGeometry && geometry) {
      headerFlags |= HeaderFlags.HasGeometry;
    }
    // NOTE: HeaderFlags.HasSpatial is intentionally NOT set. No Spatial section
    // is ever written (or read — the reader has no SectionType.Spatial handler),
    // so setting the flag only misleads consumers of CacheHeaderInfo into
    // believing a hierarchy is present. The viewer rebuilds spatialHierarchy
    // from relationships on load regardless. Re-introduce the flag only if a
    // Spatial section writer+reader is actually added.
    if (omitSourceHash) {
      headerFlags |= HeaderFlags.SourceHashUnset;
    }

    const header: CacheHeader = {
      magic: 0x4C434649,
      version: FORMAT_VERSION,
      flags: headerFlags,
      sourceHash,
      schema: dataStore.schema,
      entityCount: dataStore.entityCount,
      totalVertices,
      totalTriangles,
      sectionCount: sections.length,
    };

    // Assemble final buffer
    const totalSize = currentOffset;
    const finalWriter = new BufferWriter(totalSize);

    // Write header and section table
    writeHeader(finalWriter, header, sections);

    // Write section data
    for (const { buffer } of sectionBuffers) {
      finalWriter.writeBytes(new Uint8Array(buffer));
    }

    return finalWriter.build();
  }

  private writeSection(fn: () => ArrayBuffer): ArrayBuffer {
    return fn();
  }
}
