/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A populated `IfcDataStore` for a format whose reader hands over finished data
 * tables instead of STEP bytes. IFCX is the first caller.
 */

import {
  attachDataStoreAccessors,
  contiguousSourceBytes,
  declareLengthUnitScale,
  type IfcDataStore,
  type IfcStoreData,
} from '@ifc-lite/parser';

/** The tables a reader built. Carried into the store as they are. */
export type TabularStoreTables =
  Pick<IfcDataStore, 'strings' | 'entities' | 'properties' | 'quantities' | 'relationships'>
  & Partial<Pick<IfcDataStore, 'spatialHierarchy' | 'derivedEntities'>>;

/** What the tables cannot say about the file they came from. */
export interface TabularStoreMeta {
  /**
   * The schema the entity table's type names belong to. Carried as given, but
   * `'IFC5'` is also how consumers recognise a store with no STEP bytes today
   * (`iterateEffectiveEntities`, `getMaxExpressId`, the export gates).
   */
  schemaVersion: IfcDataStore['schemaVersion'];
  /** The file's bytes, kept as the store's `source`. */
  source: ArrayBuffer;
  fileSize: number;
  parseTime: number;
  /** Length unit scale to SI metres. Finite and positive: the reader resolves the unit before calling. */
  lengthUnitScale: number;
  /** `'declared'` when the file states its unit, `'default'` when the format assumes one. */
  lengthUnitSource: NonNullable<IfcDataStore['lengthUnitSource']>;
  georeferencing?: NonNullable<IfcDataStore['georeferencing']>;
}

/**
 * Build the `IfcDataStore` for tables a reader has already populated.
 *
 * Such a store cannot route through `createSyntheticDataStore` (it builds empty
 * tables), so the accessors are attached to the populated store instead.
 *
 * `attachDataStoreAccessors` then wires `getEntity`/`getEntitiesByType` through the
 * STEP `BufferEntitySource`, which cannot read a store whose source is not STEP and
 * whose byte index is empty: it would return null/[] for every entity. Both are
 * overridden to serve the `IfcEntity` contract from the populated entity table. (Raw
 * STEP attribute lists do not exist here, so `attributes` is empty: identity rides
 * `type`, and name/GlobalId come from the entity table via the store's other accessors.)
 */
export function buildTabularDataStore(tables: TabularStoreTables, meta: TabularStoreMeta): IfcDataStore {
  // Typed as `IfcStoreData`, never cast to it: a cast hides a wrong `source` shape (#2183).
  // @raw-entity-enumeration-ok the store is being built from the reader's finished tables; no mutation view exists yet
  const storeData: IfcStoreData = {
    fileSize: meta.fileSize,
    schemaVersion: meta.schemaVersion,
    lengthUnitScale: meta.lengthUnitScale,
    lengthUnitSource: meta.lengthUnitSource,
    entityCount: tables.entities.count,
    parseTime: meta.parseTime,
    source: contiguousSourceBytes(new Uint8Array(meta.source)),
    entityIndex: { byId: new Map(), byType: new Map() },
    strings: tables.strings,
    entities: tables.entities,
    derivedEntities: tables.derivedEntities,
    properties: tables.properties,
    quantities: tables.quantities,
    relationships: tables.relationships,
    spatialHierarchy: tables.spatialHierarchy,
    georeferencing: meta.georeferencing,
  };
  const dataStore = attachDataStoreAccessors(storeData);

  // Consumers that derive the unit from `source` + `entityIndex` (extractLengthUnitScale) find no IFCPROJECT in a
  // store without STEP bytes and would warn on every call; hand them the scale the reader stated.
  declareLengthUnitScale(dataStore.entityIndex, meta.lengthUnitScale);

  const entityTable = tables.entities;
  const idsByType = new Map<string, number[]>();
  const knownIds = new Set<number>();
  for (const id of entityTable.expressId) {
    if (!id) continue;
    knownIds.add(id);
    const key = entityTable.getTypeName(id).toUpperCase();
    const bucket = idsByType.get(key);
    if (bucket) bucket.push(id);
    else idsByType.set(key, [id]);
  }
  dataStore.getEntity = (expressId) =>
    knownIds.has(expressId)
      ? { expressId, type: entityTable.getTypeName(expressId), attributes: [] }
      : null;
  dataStore.getEntitiesByType = (typeName) =>
    (idsByType.get(typeName.toUpperCase()) ?? []).map((expressId) => ({
      expressId,
      type: entityTable.getTypeName(expressId),
      attributes: [],
    }));

  return dataStore;
}
