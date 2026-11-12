/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A cache hit's runtime store pieces: the entity index from cached columns and the lazy on-demand maps. */

import type { CachedEntityIndexColumns } from '@ifc-lite/cache';
import { CompactEntityIndex, type IfcDataStore, type IfcStoreData } from '@ifc-lite/parser';
import type { OnDemandMaps } from '../utils/spatialHierarchy.js';

export function buildEntityIndexFromCachedColumns(columns: CachedEntityIndexColumns): IfcDataStore['entityIndex'] {
  const byId = new CompactEntityIndex(
    columns.ids,
    columns.byteOffsets,
    columns.byteLengths,
    columns.typeIndices,
    columns.typeNames,
  );
  return { byId, byType: groupIdsByType(columns) };
}

/**
 * `byType` from the columns: every id under its type name, in column order, types in order of
 * first appearance. Grouped by type index (one array slot per type) rather than one string-keyed
 * Map lookup per entity, which was most of the ~44 ms this took on a large model's reopen.
 */
function groupIdsByType({ ids, typeIndices, typeNames }: CachedEntityIndexColumns): Map<string, number[]> {
  const groups: number[][] = new Array(typeNames.length);
  const firstSeen: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    const t = typeIndices[i];
    let group = groups[t];
    if (group === undefined) {
      group = groups[t] = [];
      firstSeen.push(t);
    }
    group.push(ids[i]);
  }
  const byType = new Map<string, number[]>();
  for (const t of firstSeen) {
    const name = typeNames[t];
    const existing = byType.get(name);
    if (existing === undefined) byType.set(name, groups[t]);
    // Two type indices with one name (not written today) must interleave in column order, as before.
    else return groupIdsByTypeName(ids, typeIndices, typeNames);
  }
  return byType;
}

function groupIdsByTypeName(ids: Uint32Array, typeIndices: Uint16Array, typeNames: string[]): Map<string, number[]> {
  const byType = new Map<string, number[]>();
  for (let i = 0; i < ids.length; i++) {
    const type = typeNames[typeIndices[i]];
    let list = byType.get(type);
    if (!list) byType.set(type, (list = []));
    list.push(ids[i]);
  }
  return byType;
}

export const ON_DEMAND_KEYS = ['onDemandPropertyMap', 'onDemandQuantityMap', 'onDemandMaterialMap'] as const;

/**
 * The on-demand maps of a cache hit, built on first read of any of them (all three at once) instead
 * of before the load is interactive (~35 ms on a large model): only a property, quantity or
 * material read, a filter schema, a list/lens or a store transport needs them. Each key then holds
 * a plain value; assigning one replaces it as before.
 */
export function defineLazyOnDemandMaps(store: IfcStoreData, build: () => OnDemandMaps): void {
  let maps: OnDemandMaps | null = null;
  const materialize = (): OnDemandMaps => {
    if (maps) return maps;
    maps = build();
    for (const key of ON_DEMAND_KEYS) Object.defineProperty(store, key, { value: maps[key], writable: true, enumerable: true, configurable: true });
    return maps;
  };
  for (const key of ON_DEMAND_KEYS) {
    Object.defineProperty(store, key, {
      get: () => materialize()[key],
      set: (value: Map<number, number[]> | undefined) => {
        materialize();
        Object.defineProperty(store, key, { value, writable: true, enumerable: true, configurable: true });
      },
      enumerable: true,
      configurable: true,
    });
  }
}
