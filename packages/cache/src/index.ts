/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/cache - Binary cache format for fast model loading
 *
 * The .ifc-lite format provides 5-10x faster loading compared to parsing
 * IFC files directly, by pre-computing all data structures.
 *
 * @example
 * ```typescript
 * import { BinaryCacheWriter, BinaryCacheReader } from '@ifc-lite/cache';
 *
 * // Write cache
 * const writer = new BinaryCacheWriter();
 * const cacheBuffer = await writer.write(dataStore, geometry, sourceBuffer);
 *
 * // Read cache
 * const reader = new BinaryCacheReader();
 * const { dataStore, geometry } = await reader.read(cacheBuffer);
 * ```
 */

export { BinaryCacheWriter } from './writer.js';
export type { GeometryData } from './writer.js';

export { BinaryCacheReader } from './reader.js';

export {
  MAGIC,
  FORMAT_VERSION,
  HEADER_SIZE,
  SECTION_ENTRY_SIZE,
  SectionType,
  SchemaVersion,
  HeaderFlags,
  SectionFlags,
} from './types.js';

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
  IfcDataStore,
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
