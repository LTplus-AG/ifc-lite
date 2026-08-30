/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The server-hydrated `EntityTable` — one of the three implementations of that
 * interface, beside `entityTableFromColumns` (packages/data) and the
 * cache-restored table, which routes through `entityTableFromColumns` itself.
 * Split out of `serverDataModel.ts` so the implementations can be read side by
 * side: every accessor here has a counterpart there that must give the same
 * answer for the same model.
 */

import type { DataModel } from '@ifc-lite/server-client';
import { CompactEntityIndexBuilder, type CompactEntityIndex } from '@ifc-lite/parser';
import {
  IfcTypeEnum,
  IfcTypeEnumFromString,
  IfcTypeEnumToString,
  EntityFlags,
  IFC_ENTITY_NAMES,
  exactNameOfRow,
  type EntityTable,
} from '@ifc-lite/data';
import { StringTable } from '@ifc-lite/data';

/**
 * Build EntityTable from server data model
 */
export function buildEntityTable(
  dataModel: DataModel,
  strings: StringTable
): { entities: EntityTable; entityById: CompactEntityIndex; typeGroups: Map<IfcTypeEnum, number[]> } {
  // Columnar consumption (issue #1841): iterate the decoder's raw columns by
  // index instead of a per-entity Map (V8 caps Map at 2^24 entries).
  const cols = dataModel.entities.columns;
  const entityCount = cols.count;

  // Pre-allocate TypedArrays
  const expressId = new Uint32Array(entityCount);
  const typeEnumArr = new Uint16Array(entityCount);
  const globalIdArr = new Uint32Array(entityCount);
  const nameArr = new Uint32Array(entityCount);
  const descriptionArr = new Uint32Array(entityCount);
  const objectTypeArr = new Uint32Array(entityCount);
  // Tag / PredefinedType from the v4 data-model payload (issue #1765).
  const tagArr = new Uint32Array(entityCount);
  const predefinedTypeArr = new Uint32Array(entityCount);
  // Raw IFC class name per row, interned. `IfcTypeEnum` covers only a subset of
  // the schema, so `getTypeName` falls back to this exactly as
  // `entityTableFromColumns` (packages/data/src/entity-table.ts) does — without
  // it an IfcPump loaded from the server reports 'Unknown'.
  const rawTypeNameArr = new Uint32Array(entityCount);
  const flagsArr = new Uint8Array(entityCount);
  const containedInStoreyArr = new Int32Array(entityCount).fill(-1);
  const definedByTypeArr = new Int32Array(entityCount).fill(-1);
  const geometryIndexArr = new Int32Array(entityCount).fill(-1);

  // Maps for fast lookup
  const globalIdToExpressId = new Map<string, number>();
  const typeGroups = new Map<IfcTypeEnum, number[]>();

  // Canonical compact byId index (replaces the hand-rolled Map of faked
  // EntityRef objects). The server has no source buffer, so byteOffset /
  // byteLength are 0 — matching the previous faked EntityRef exactly.
  const byIdBuilder = new CompactEntityIndexBuilder(entityCount);

  // Single pass through entity columns
  for (let idx = 0; idx < entityCount; idx++) {
    const id = cols.expressId[idx];
    expressId[idx] = id;
    const typeName = cols.typeName[idx] ?? '';
    const typeVal = IfcTypeEnumFromString(typeName);
    typeEnumArr[idx] = typeVal;
    // Same canonicalisation as `EntityTableBuilder.add` and `setTypeOverride`
    // below, so all three EntityTable implementations spell a class the same way.
    rawTypeNameArr[idx] = strings.intern(IFC_ENTITY_NAMES[typeName.toUpperCase()] ?? typeName);
    const globalIdString = cols.globalId[idx] || '';
    globalIdArr[idx] = strings.intern(globalIdString);
    if (globalIdString) {
      globalIdToExpressId.set(globalIdString, id);
    }
    nameArr[idx] = strings.intern(cols.name[idx] || '');
    descriptionArr[idx] = strings.intern(cols.description?.[idx] || '');
    objectTypeArr[idx] = strings.intern(cols.objectType?.[idx] || '');
    tagArr[idx] = strings.intern(cols.tag?.[idx] || '');
    predefinedTypeArr[idx] = strings.intern(cols.predefinedType?.[idx] || '');
    flagsArr[idx] = cols.hasGeometry[idx] !== 0 ? EntityFlags.HAS_GEOMETRY : 0;

    byIdBuilder.add(id, typeName, 0, 0);

    if (!typeGroups.has(typeVal)) {
      typeGroups.set(typeVal, []);
    }
    typeGroups.get(typeVal)!.push(idx);
  }

  const entityById = byIdBuilder.build();

  // Rows above were filled in column order, so the ServerEntityIndex row
  // position IS the EntityTable index — binary search instead of an
  // idToIndex Map (which would hit the same 2^24 ceiling).
  const indexOfId = (id: number): number => dataModel.entities.rowIndexOf(id);

  // Additive display-class overrides (UI retype). See entity-table.ts.
  const typeOverrides = new Map<number, string>();

  /** One interned-string column accessor, shared by every string getter. */
  const strCol = (col: Uint32Array) => (id: number) => {
    const i = indexOfId(id);
    return i >= 0 ? strings.get(col[i]) : '';
  };

  const entities: EntityTable = {
    count: entityCount,
    expressId,
    typeEnum: typeEnumArr,
    globalId: globalIdArr,
    name: nameArr,
    description: descriptionArr,
    objectType: objectTypeArr,
    rawTypeName: rawTypeNameArr,
    flags: flagsArr,
    containedInStorey: containedInStoreyArr,
    definedByType: definedByTypeArr,
    geometryIndex: geometryIndexArr,
    typeRanges: new Map(), // Deprecated - use getByType which uses typeGroups directly
    getGlobalId: strCol(globalIdArr),
    getName: strCol(nameArr),
    getDescription: strCol(descriptionArr),
    getObjectType: strCol(objectTypeArr),
    getTag: strCol(tagArr),
    getPredefinedType: strCol(predefinedTypeArr),
    getTypeName: (id) => {
      const override = typeOverrides.get(id);
      if (override !== undefined) return override;
      const i = indexOfId(id);
      if (i < 0) return 'Unknown';
      const enumName = IfcTypeEnumToString(typeEnumArr[i]);
      if (enumName !== 'Unknown') return enumName;
      return strings.get(rawTypeNameArr[i]) || 'Unknown';
    },
    // The declared class, for export rather than grouping. `rawTypeNameArr`
    // above holds the server's own class string, so this table can answer it
    // exactly as `entityTableFromColumns` does — reading `getTypeName` here
    // would resolve through `IfcTypeEnum` and hand an IFCDOORSTANDARDCASE row
    // the coalesced 'IfcDoor'. A retype outranks the parsed class, matching
    // `getTypeName` above, and `setTypeOverride` already canonicalised it.
    getExactTypeName: (id) =>
      typeOverrides.get(id) ?? exactNameOfRow(strings, rawTypeNameArr, typeEnumArr, indexOfId(id)),
    hasGeometry: (id) => {
      const i = indexOfId(id);
      return i >= 0 ? (flagsArr[i] & EntityFlags.HAS_GEOMETRY) !== 0 : false;
    },
    getByType: (type) => {
      // Use typeGroups directly - indices stored there map to expressId array
      const indices = typeGroups.get(type);
      if (!indices) return [];
      return indices.map(idx => expressId[idx]);
    },
    getTypeEnum: (id) => {
      const override = typeOverrides.get(id);
      if (override !== undefined) return IfcTypeEnumFromString(override);
      const i = indexOfId(id);
      return i >= 0 ? typeEnumArr[i] as IfcTypeEnum : IfcTypeEnum.Unknown;
    },
    setTypeOverride: (id, typeName) => {
      if (typeName === null) typeOverrides.delete(id);
      // Canonicalise on the way in, matching `entityTableFromColumns`
      // (packages/data/src/entity-table.ts) and the cache-restored table.
      // `getTypeName` echoes the override back verbatim and consumers like
      // `isSpatialStructureTypeName` match the PascalCase form, so storing
      // the caller's raw UPPERCASE token makes a retyped entity invisible to
      // them. All three EntityTable implementations must agree here.
      else typeOverrides.set(id, IFC_ENTITY_NAMES[typeName.toUpperCase()] ?? typeName.toUpperCase());
    },
    getExpressIdByGlobalId: (gid) => {
      return globalIdToExpressId.get(gid) ?? -1;
    },
  };

  return { entities, entityById, typeGroups };
}
