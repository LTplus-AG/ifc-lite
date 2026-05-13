/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entity table - columnar storage for IFC entities
 * Uses TypedArrays for cache-efficient bulk operations
 */

import type { StringTable } from './string-table.js';
import { IfcTypeEnum, EntityFlags, IfcTypeEnumFromString, IfcTypeEnumToString } from './types.js';
import { IFC_ENTITY_NAMES } from './ifc-entity-names.js';

/** Convert UPPERCASE IFC type name to PascalCase using the generated schema name map */
function normalizeIfcUpperCase(upper: string): string {
  return IFC_ENTITY_NAMES[upper] ?? upper;
}

export interface EntityTable {
  readonly count: number;

  expressId: Uint32Array;
  typeEnum: Uint16Array;
  globalId: Uint32Array;
  name: Uint32Array;
  description: Uint32Array;
  objectType: Uint32Array;
  flags: Uint8Array;

  containedInStorey: Int32Array;
  definedByType: Int32Array;
  geometryIndex: Int32Array;
  /**
   * Interned-string indices for raw IFC type names (used by `getTypeName`
   * fallback). Optional because older constructors (server-data hydration,
   * legacy cache reads) didn't track it; absent means the enum-only name
   * is the only display string available.
   */
  rawTypeName?: Uint32Array;

  typeRanges: Map<IfcTypeEnum, { start: number; end: number }>;

  getGlobalId(expressId: number): string;
  getName(expressId: number): string;
  getDescription(expressId: number): string;
  getObjectType(expressId: number): string;
  getTypeName(expressId: number): string;
  hasGeometry(expressId: number): boolean;
  getByType(type: IfcTypeEnum): number[];

  /** Get IfcTypeEnum for an expressId using internal index. Returns IfcTypeEnum.Unknown if not found. */
  getTypeEnum(expressId: number): IfcTypeEnum;

  /** Get expressId by IFC GlobalId string (22-char GUID). Returns -1 if not found. */
  getExpressIdByGlobalId(globalId: string): number;

  /** Get all GlobalId → expressId mappings (for BCF integration) */
  getGlobalIdMap(): Map<string, number>;
}

export class EntityTableBuilder {
  private count: number = 0;
  private strings: StringTable;

  expressId: Uint32Array;
  typeEnum: Uint16Array;
  globalId: Uint32Array;
  name: Uint32Array;
  description: Uint32Array;
  objectType: Uint32Array;
  flags: Uint8Array;
  containedInStorey: Int32Array;
  definedByType: Int32Array;
  geometryIndex: Int32Array;
  /** Raw type name string index (for fallback display of unknown types) */
  rawTypeName: Uint32Array;

  private typeStarts: Map<IfcTypeEnum, number> = new Map();
  private typeCounts: Map<IfcTypeEnum, number> = new Map();

  constructor(capacity: number, strings: StringTable) {
    this.strings = strings;

    this.expressId = new Uint32Array(capacity);
    this.typeEnum = new Uint16Array(capacity);
    this.globalId = new Uint32Array(capacity);
    this.name = new Uint32Array(capacity);
    this.description = new Uint32Array(capacity);
    this.objectType = new Uint32Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.containedInStorey = new Int32Array(capacity).fill(-1);
    this.definedByType = new Int32Array(capacity).fill(-1);
    this.geometryIndex = new Int32Array(capacity).fill(-1);
    this.rawTypeName = new Uint32Array(capacity);
  }
  
  add(
    expressId: number,
    type: string,
    globalId: string,
    name: string,
    description: string,
    objectType: string,
    hasGeometry: boolean = false,
    isType: boolean = false
  ): void {
    const i = this.count++;

    this.expressId[i] = expressId;
    const typeEnum = IfcTypeEnumFromString(type);
    this.typeEnum[i] = typeEnum;
    this.globalId[i] = this.strings.intern(globalId);
    this.name[i] = this.strings.intern(name);
    this.description[i] = this.strings.intern(description);
    this.objectType[i] = this.strings.intern(objectType);
    // Store normalized raw type name for fallback display of unknown types
    this.rawTypeName[i] = this.strings.intern(normalizeIfcUpperCase(type));
    
    let flags = 0;
    if (hasGeometry) flags |= EntityFlags.HAS_GEOMETRY;
    if (isType) flags |= EntityFlags.IS_TYPE;
    this.flags[i] = flags;
    
    // Track type ranges
    if (!this.typeStarts.has(typeEnum)) {
      this.typeStarts.set(typeEnum, i);
      this.typeCounts.set(typeEnum, 0);
    }
    this.typeCounts.set(typeEnum, this.typeCounts.get(typeEnum)! + 1);
  }
  
  build(): EntityTable {
    // Trim arrays to actual size
    const trim = <T extends TypedArray>(arr: T): T => {
      return arr.subarray(0, this.count) as T;
    };

    // Build type ranges (kept for cache serialization backward compat)
    const typeRanges = new Map<IfcTypeEnum, { start: number; end: number }>();
    for (const [type, start] of this.typeStarts) {
      const count = this.typeCounts.get(type)!;
      typeRanges.set(type, { start, end: start + count });
    }

    return entityTableFromColumns(
      {
        count: this.count,
        expressId: trim(this.expressId),
        typeEnum: trim(this.typeEnum),
        globalId: trim(this.globalId),
        name: trim(this.name),
        description: trim(this.description),
        objectType: trim(this.objectType),
        flags: trim(this.flags),
        containedInStorey: trim(this.containedInStorey),
        definedByType: trim(this.definedByType),
        geometryIndex: trim(this.geometryIndex),
        rawTypeName: trim(this.rawTypeName),
        typeRanges,
      },
      this.strings,
    );
  }
}

type TypedArray = Uint32Array | Uint16Array | Uint8Array | Int32Array;

/**
 * Plain-data column representation of an `EntityTable`.
 *
 * Holds only typed arrays + a small `typeRanges` map (used for cache
 * serialization). Crucially has no closures, so it can be structured-cloned
 * across worker boundaries with the underlying buffers in the transfer list.
 *
 * `rawTypeName` carries the interned-string index for the raw IFC type so
 * `getTypeName()` can fall back when the type isn't in the generated enum.
 */
export interface EntityTableColumns {
  count: number;
  expressId: Uint32Array;
  typeEnum: Uint16Array;
  globalId: Uint32Array;
  name: Uint32Array;
  description: Uint32Array;
  objectType: Uint32Array;
  flags: Uint8Array;
  containedInStorey: Int32Array;
  definedByType: Int32Array;
  geometryIndex: Int32Array;
  rawTypeName?: Uint32Array;
  typeRanges?: Map<IfcTypeEnum, { start: number; end: number }>;
}

/**
 * Build a live `EntityTable` (with closures) from raw columnar data and a
 * `StringTable`. Mirrors the closure block previously inlined in
 * `EntityTableBuilder.build()` so worker transports and cache loaders share
 * one source of truth.
 */
export function entityTableFromColumns(
  columns: EntityTableColumns,
  strings: StringTable,
): EntityTable {
  const {
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
  } = columns;
  // Zero-fill fallback: callers without a raw-type column (cache reads,
  // server hydration) lose the unknown-type display fallback but the
  // closure still returns a correct value for known enums.
  const rawTypeName = columns.rawTypeName ?? new Uint32Array(count);

  // Per-type index built from the live typeEnum column. Cannot be
  // reconstructed from typeRanges alone because IFC files can interleave
  // entities of different types within one stream.
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

  const typeRanges = columns.typeRanges ?? new Map<IfcTypeEnum, { start: number; end: number }>();
  if (columns.typeRanges === undefined) {
    // Derive ranges from typeIndices when not supplied. Caller will only
    // hit this branch on transport-rebuild paths; cache loads pass them.
    for (const [type, indices] of typeIndices) {
      typeRanges.set(type, { start: indices[0] ?? 0, end: (indices[indices.length - 1] ?? -1) + 1 });
    }
  }

  // PERF: O(1) expressId → row index lookup instead of linear scan.
  const idToIndex = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    idToIndex.set(expressId[i], i);
  }

  const indexOfId = (id: number): number => idToIndex.get(id) ?? -1;

  // GlobalId → expressId for BCF integration. Only populated for entities
  // that actually have a non-empty GlobalId string.
  const globalIdToExpressId = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const gidString = strings.get(globalId[i]);
    if (gidString) {
      globalIdToExpressId.set(gidString, expressId[i]);
    }
  }

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
    rawTypeName,
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
      const idx = indexOfId(id);
      if (idx < 0) return 'Unknown';
      const enumName = IfcTypeEnumToString(typeEnum[idx]);
      if (enumName !== 'Unknown') return enumName;
      return strings.get(rawTypeName[idx]) || 'Unknown';
    },
    hasGeometry: (id) => {
      const idx = indexOfId(id);
      return idx >= 0 ? (flags[idx] & EntityFlags.HAS_GEOMETRY) !== 0 : false;
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
      const idx = indexOfId(id);
      return idx >= 0 ? typeEnum[idx] as IfcTypeEnum : IfcTypeEnum.Unknown;
    },

    getExpressIdByGlobalId: (gid) => globalIdToExpressId.get(gid) ?? -1,

    getGlobalIdMap: () => new Map(globalIdToExpressId),
  };
}

/**
 * Extract the column buffers (no closures) from an `EntityTable`. Used by
 * the parser worker → main transport path and any other consumer that
 * needs to hand the table to a different realm.
 *
 * Returned typed arrays alias the same `ArrayBuffer`s as the source table
 * — when used in a `postMessage` transfer list those buffers detach.
 */
export function entityTableToColumns(table: EntityTable): EntityTableColumns {
  return {
    count: table.count,
    expressId: table.expressId,
    typeEnum: table.typeEnum,
    globalId: table.globalId,
    name: table.name,
    description: table.description,
    objectType: table.objectType,
    flags: table.flags,
    containedInStorey: table.containedInStorey,
    definedByType: table.definedByType,
    geometryIndex: table.geometryIndex,
    rawTypeName: table.rawTypeName ?? new Uint32Array(table.count),
    typeRanges: table.typeRanges,
  };
}
