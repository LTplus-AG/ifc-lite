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

/** Current format version */
export const FORMAT_VERSION = 4;

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
export interface IfcDataStore {
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
  dataStore: IfcDataStore;
  entityIndex?: CachedEntityIndexColumns;
  geometry?: {
    meshes: MeshData[];
    totalVertices: number;
    totalTriangles: number;
    coordinateInfo: CoordinateInfo;
  };
}

/** Header size in bytes */
export const HEADER_SIZE = 64;

/** Section entry size in bytes */
export const SECTION_ENTRY_SIZE = 16;
