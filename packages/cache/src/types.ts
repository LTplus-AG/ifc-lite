/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Binary cache format types for .ifc-lite files
 */

import type { EntityTable, PropertyTable, QuantityTable, RelationshipGraph, StringTable, SpatialHierarchy } from '@ifc-lite/data';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';

/** Magic bytes: "IFCL" */
export const MAGIC = 0x4C434649; // "IFCL" in little-endian

/**
 * Current format version.
 *
 * v5: per-mesh `geometryClass` byte (Model/Types view switch, #957). Earlier
 * caches restored every mesh as class 0, so instanced type-library geometry
 * (class 2) rendered in Model mode and the Model/Types switch vanished
 * (`hasTypeGeometry` saw no non-zero classes). Bumping the version also bumps
 * the viewer's cache key, so stale v4 entries miss and re-mesh fresh.
 *
 * v6: per-mesh local-frame `origin` (3×f64) — the per-element AABB-centre the
 * wasm pipeline stores so building-scale f32 vertices don't collapse into fans
 * (world = origin + position). Without it, a cache restored from a local-frame
 * load has small local positions but no origin → every element renders scattered
 * near scene origin. The bump also invalidates pre-origin caches so they re-mesh.
 *
 * v7: IfcGroup-family entities (IfcZone / IfcSystem / IfcDistributionSystem) and
 * IfcSpatialZone now enter the EntityTable WITH their Name/LongName/ObjectType
 * (#1075). The binary format is unchanged, but a v6 cache has no group rows, so
 * a restored model would still show "Group #<id>" and omit zones/systems from
 * lists/lens. The bump invalidates pre-#1075 caches so they re-parse and resolve
 * the names.
 *
 * v8/v9: material-layer walls tag their per-layer slices `geometryClass` 3, and
 * the renderer draws that class BACKFACE-CULLED so the thin coincident-faced
 * slabs show the build-up without z-fighting into a hollow shell (v8 briefly
 * emitted a separate class-4 solid instead; v9 dropped it for the cull). The
 * byte format is unchanged (a geometryClass uint8), but a pre-v9 cache has the
 * old class-0 (or class-4) layer geometry, so a restored wall would render the
 * old glitchy stack. The bump invalidates those caches so layered walls re-mesh
 * with the class-3 slices the cull path expects.
 */
/**
 * v9→v10: GPU instancing. Opaque repeated occurrences are partitioned off the flat
 * geometry section into IFNS instancing shards (rendered from compact templates).
 * A v9 cache predates the shard section, so a v9 hit would restore the flat meshes
 * only and silently drop all instanced occurrences — the bump invalidates those so
 * the model re-meshes (and re-writes a complete v10 cache with the shards).
 */
export const FORMAT_VERSION = 10;

/** Section types in the binary format */
export enum SectionType {
  Strings = 1,
  Entities = 2,
  Properties = 3,
  Quantities = 4,
  Relationships = 5,
  Geometry = 6,
  Spatial = 7,
  Bounds = 8,
  EntityIndex = 9,
  InstancedShards = 10,
}

/** IFC schema version */
export enum SchemaVersion {
  IFC2X3 = 0,
  IFC4 = 1,
  IFC4X3 = 2,
}

/** Header flags */
export enum HeaderFlags {
  None = 0,
  Compressed = 1 << 0,
  HasGeometry = 1 << 1,
  HasSpatial = 1 << 2,
}

/** Section flags */
export enum SectionFlags {
  None = 0,
  Compressed = 1 << 0,
}

/**
 * Header structure (64 bytes)
 */
export interface CacheHeader {
  magic: number;           // 4 bytes - "IFCL"
  version: number;         // 2 bytes - format version
  flags: HeaderFlags;      // 2 bytes - header flags
  sourceHash: bigint;      // 8 bytes - xxhash64 of source IFC
  schema: SchemaVersion;   // 1 byte - IFC schema version
  entityCount: number;     // 4 bytes - total entities
  totalVertices: number;   // 4 bytes - total vertices
  totalTriangles: number;  // 4 bytes - total triangles
  sectionCount: number;    // 2 bytes - number of sections
  // Reserved: 33 bytes to pad to 64
}

/**
 * Section table entry (16 bytes each)
 */
export interface SectionEntry {
  type: SectionType;       // 2 bytes
  flags: SectionFlags;     // 2 bytes
  offset: number;          // 4 bytes - byte offset from file start
  size: number;            // 4 bytes - uncompressed size
  compressedSize: number;  // 4 bytes - 0 if not compressed
}

/**
 * Options for writing cache
 */
export interface CacheWriteOptions {
  /** Include geometry data (default: true) */
  includeGeometry?: boolean;
  /** Include spatial hierarchy (default: true) */
  includeSpatialHierarchy?: boolean;
  /** Compress sections (default: false, future feature) */
  compress?: boolean;
}

/**
 * Options for reading cache
 */
export interface CacheReadOptions {
  /** Skip loading geometry (default: false) */
  skipGeometry?: boolean;
  /** Skip loading spatial hierarchy (default: false) */
  skipSpatialHierarchy?: boolean;
  /** Validate source hash against provided buffer */
  sourceBuffer?: ArrayBuffer;
}

/**
 * Result from reading header only
 */
export interface CacheHeaderInfo {
  version: number;
  schema: SchemaVersion;
  sourceHash: bigint;
  entityCount: number;
  totalVertices: number;
  totalTriangles: number;
  hasGeometry: boolean;
  hasSpatialHierarchy: boolean;
  sections: SectionEntry[];
}

/**
 * Complete data store for IFC model
 */
export interface CacheDataStore {
  schema: SchemaVersion;
  entityCount: number;
  strings: StringTable;
  entities: EntityTable;
  properties: PropertyTable;
  quantities: QuantityTable;
  relationships: RelationshipGraph;
  spatialHierarchy?: SpatialHierarchy;
  entityIndex?: CacheEntityIndex;
}

export interface CacheEntityRef {
  expressId: number;
  type: string;
  byteOffset: number;
  byteLength: number;
  lineNumber?: number;
}

export interface CacheEntityIndex {
  byId: Iterable<[number, CacheEntityRef]>;
}

export interface CachedEntityIndexColumns {
  ids: Uint32Array;
  byteOffsets: Uint32Array;
  byteLengths: Uint32Array;
  typeIndices: Uint16Array;
  typeNames: string[];
}

/**
 * Result from reading cache
 */
export interface CacheReadResult {
  dataStore: CacheDataStore;
  entityIndex?: CachedEntityIndexColumns;
  geometry?: {
    meshes: MeshData[];
    totalVertices: number;
    totalTriangles: number;
    coordinateInfo: CoordinateInfo;
    /** Raw IFNS GPU-instancing shard bytes (opaque repeated occurrences), persisted
     *  so a cache reload re-uploads them via the instanced path instead of dropping
     *  the instanced geometry. Empty/absent for non-instanced models. */
    instancedShards?: ArrayBuffer[];
  };
}

/** Header size in bytes */
export const HEADER_SIZE = 64;

/** Section entry size in bytes */
export const SECTION_ENTRY_SIZE = 16;
