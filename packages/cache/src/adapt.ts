/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type {
  StringTable,
  EntityTable,
  PropertyTable,
  QuantityTable,
  RelationshipGraph,
  SpatialHierarchy,
} from '@ifc-lite/data';
import { SchemaVersion, type CacheDataStore } from './types.js';

/**
 * The subset of `@ifc-lite/parser`'s `IfcDataStore` (what `IfcParser.parseColumnar`
 * and every other parser entry point return) that {@link toCacheDataStore} needs.
 * Declared structurally here, rather than importing `IfcDataStore` itself, so
 * `@ifc-lite/cache` doesn't take on a runtime dependency on `@ifc-lite/parser`
 * just to name a type — every field below is already typed against
 * `@ifc-lite/data`, which `@ifc-lite/cache` depends on regardless.
 */
export interface ParsedIfcStore {
  schemaVersion: 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';
  entityCount: number;
  strings: StringTable;
  entities: EntityTable;
  properties: PropertyTable;
  quantities: QuantityTable;
  relationships: RelationshipGraph;
  spatialHierarchy?: SpatialHierarchy;
}

/**
 * Map a parser store's string `schemaVersion` to the cache format's numeric
 * {@link SchemaVersion}. The binary format predates IFC5 (`SchemaVersion` has
 * no IFC5 member), so an IFC5 source round-trips through the cache tagged as
 * IFC2X3 — the same fallback the viewer's read-side cache hook uses for the
 * inverse mapping. If your application needs to distinguish IFC5 sources
 * after a cache read, track that separately; the cache header cannot carry
 * it today.
 */
function toSchemaVersion(schemaVersion: ParsedIfcStore['schemaVersion']): SchemaVersion {
  switch (schemaVersion) {
    case 'IFC4':
      return SchemaVersion.IFC4;
    case 'IFC4X3':
      return SchemaVersion.IFC4X3;
    default:
      return SchemaVersion.IFC2X3;
  }
}

/**
 * Adapt a parsed store (an `IfcDataStore` from `@ifc-lite/parser`, or
 * anything else matching {@link ParsedIfcStore}) into the {@link
 * CacheDataStore} shape {@link BinaryCacheWriter.write} requires. This is the
 * conversion the `@ifc-lite/cache` README's quickstart needs and previously
 * didn't show — `parseColumnar`'s return type and `write`'s parameter type
 * differ in the `schema`/`schemaVersion` key and its string-vs-enum
 * representation, so passing a parsed store straight to `write` doesn't
 * typecheck (issue #3759).
 *
 * Two things this does NOT do, because the source types genuinely differ:
 * - It does not carry over an entity index. The parser's `entityIndex.byId`
 *   is a live map keyed by parsed entity data; the cache format's
 *   `CacheEntityIndex.byId` is a serializable `Iterable<[number,
 *   CacheEntityRef]>` of byte offsets into the source. Nothing today
 *   produces the latter from the former, so the cache is written without an
 *   entity-index section (it's optional — {@link BinaryCacheWriter.write}
 *   skips that section entirely when absent) rather than papering over the
 *   mismatch with a cast.
 * - It does not materialize `properties`/`quantities`. For a STEP-parsed
 *   store those tables are empty by design — properties resolve lazily on
 *   demand — and this adapter serializes exactly what the store carries, so
 *   a cache written from a STEP parse has an empty property/quantity table
 *   too. See the `@ifc-lite/cache` package docs and `docs/guide/querying.md`
 *   for what that means for a cache-restored model.
 */
export function toCacheDataStore(store: ParsedIfcStore): CacheDataStore {
  return {
    schema: toSchemaVersion(store.schemaVersion),
    entityCount: store.entityCount,
    strings: store.strings,
    entities: store.entities,
    properties: store.properties,
    quantities: store.quantities,
    relationships: store.relationships,
    spatialHierarchy: store.spatialHierarchy,
  };
}
