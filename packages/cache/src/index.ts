/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/cache - Binary cache format for fast model loading
 *
 * The .ifc-lite format skips re-running the parse + tessellation pipeline on
 * a warm load: entities, relationships, spatial hierarchy and geometry are
 * all pre-computed and read back directly. That's where the 5-10x is real.
 *
 * Properties and quantities are the exception: `write()` serializes whatever
 * the store's property/quantity tables already hold. A STEP-parsed
 * `IfcDataStore` resolves those lazily on demand and never populates the
 * tables, so a cache written straight from a STEP parse has EMPTY property
 * and quantity tables — a restored model queries properties exactly as slow
 * as a fresh parse, unless the caller separately retains the source buffer
 * and re-attaches on-demand extraction (see `docs/guide/querying.md`).
 *
 * @example
 * ```typescript
 * import { BinaryCacheWriter, BinaryCacheReader, toCacheDataStore } from '@ifc-lite/cache';
 *
 * // Write cache — toCacheDataStore adapts a parser IfcDataStore
 * // (string schemaVersion) to the format writer.write() requires
 * // (numeric SchemaVersion enum).
 * const writer = new BinaryCacheWriter();
 * const cacheBuffer = await writer.write(toCacheDataStore(dataStore), geometry, sourceBuffer);
 *
 * // Read cache
 * const reader = new BinaryCacheReader();
 * const { dataStore, geometry } = await reader.read(cacheBuffer);
 * ```
 */

export { BinaryCacheWriter } from './writer.js';
export type { GeometryData } from './writer.js';

export { BinaryCacheReader } from './reader.js';

export { toCacheDataStore } from './adapt.js';
export type { ParsedIfcStore } from './adapt.js';

export {
  MAGIC,
  FORMAT_VERSION,
  HEADER_SIZE,
  SECTION_ENTRY_SIZE,
  SectionType,
  SchemaVersion,
  HeaderFlags,
  SectionFlags,
  GeometryChunkFlags,
  GEOMETRY_CHUNK_CELL_SIZE,
  GEOMETRY_CHUNK_SOFT_BYTES,
  GEOMETRY_CHUNK_COMPRESS_MIN_BYTES,
} from './types.js';

// v13 chunked geometry: incremental access for streamed cache-hit loads
// (issue #1682 phase 4). openGeometryChunksV13 wants the Geometry section's
// absolute offset from the header's section table.
export {
  openGeometryChunksV13,
  readGeometryHeadV13,
  decodeGeometryChunk,
  groupMeshesIntoChunks,
  buildGeometrySectionV13,
} from './sections/geometry-chunks.js';
export { readInstancedShards } from './sections/instanced-shards.js';
export type { GeometryHead } from './sections/geometry-chunks.js';
export type { GeometryChunkInfo } from './types.js';

export type {
  CacheHeader,
  SectionEntry,
  CacheWriteOptions,
  CacheReadOptions,
  CacheHeaderInfo,
  CacheReadResult,
  CachedEntityIndexColumns,
  CacheEntityIndex,
  CacheEntityRef,
  CacheDataStore,
} from './types.js';

// Utilities
export { xxhash64, xxhash64Hex } from './utils/hash.js';
export { BufferWriter, BufferReader } from './utils/buffer-utils.js';

// GLB parser
export {
  parseGLB,
  extractGLBMapping,
  parseGLBToMeshData,
  loadGLBToMeshData,
} from './glb.js';

export type { ParsedGLB, GLBMapping } from './glb.js';
