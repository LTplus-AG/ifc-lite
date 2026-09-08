/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main query interface - provides multiple access patterns
 */

import { isKnownType, resolveEntityNameAlias, type IfcDataStore } from '@ifc-lite/parser';
import {
  IfcTypeEnum,
  IfcTypeEnumFromString,
  type SpatialHierarchy,
} from '@ifc-lite/data';
import { EntityQuery } from './entity-query.js';
import { EntityNode } from './entity-node.js';
import { DuckDBIntegration, type SQLResult } from './duckdb-integration.js';
import type { AABB } from '@ifc-lite/spatial';

export class IfcQuery {
  private store: IfcDataStore;
  private duckdb: DuckDBIntegration | null = null;
  
  constructor(store: IfcDataStore) {
    this.store = store;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // SQL API - Full SQL power via DuckDB-WASM
  // ═══════════════════════════════════════════════════════════════
  
  async sql(query: string): Promise<SQLResult> {
    await this.ensureDuckDB();
    return this.duckdb!.query(query);
  }
  
  private async ensureDuckDB(): Promise<void> {
    if (!this.duckdb) {
      const available = await DuckDBIntegration.isAvailable();
      if (!available) {
        throw new Error('DuckDB-WASM is not available. Install @duckdb/duckdb-wasm to use SQL queries.');
      }
      const duckdb = new DuckDBIntegration();
      try {
        await duckdb.init(this.store);
      } catch (error) {
        // Do not retain a half-initialized instance — a later sql() call would
        // otherwise reuse a poisoned DuckDBIntegration and never re-init.
        this.duckdb = null;
        throw error;
      }
      this.duckdb = duckdb;
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // FLUENT API - Type-safe query builder
  // ═══════════════════════════════════════════════════════════════
  
  walls(): EntityQuery {
    return this.ofType('IfcWall', 'IfcWallStandardCase');
  }
  
  doors(): EntityQuery {
    return this.ofType('IfcDoor');
  }
  
  windows(): EntityQuery {
    return this.ofType('IfcWindow');
  }
  
  slabs(): EntityQuery {
    return this.ofType('IfcSlab');
  }
  
  columns(): EntityQuery {
    return this.ofType('IfcColumn');
  }
  
  beams(): EntityQuery {
    return this.ofType('IfcBeam');
  }
  
  spaces(): EntityQuery {
    return this.ofType('IfcSpace');
  }
  
  ofType(...types: string[]): EntityQuery {
    // `IfcTypeEnumFromString` falls back to `IfcTypeEnum.Unknown` for any name
    // it does not recognize. That fallback conflates two very different cases:
    //
    //  1. A typo (`ofType('IfcWal')`). `IfcWal` is not an IFC entity name in
    //     any schema, so the caller can only have meant `IfcWall`. Left
    //     unchecked the query silently returns the Unknown bucket - every
    //     entity the store itself could not classify - which is neither the
    //     caller's wall nor an empty result, but some other, unrelated set of
    //     entities.
    //
    //  2. A real IFC entity name that `TYPE_STRING_TO_ENUM` (data/types.ts)
    //     simply has no entry for. That table is a curated subset, so standard
    //     types such as `IfcChiller` and `IfcActuator` - and IFC2X3's
    //     `IfcDoorStyle` and `IfcWindowStyle`, which is how 2X3 files carry
    //     door and window typing - map to `Unknown` too. For those the Unknown
    //     bucket is the only representation available and querying it is the
    //     documented, working behaviour: a file whose sole unclassified
    //     entities are door styles really does answer `ofType('IfcDoorStyle')`
    //     correctly this way.
    //
    // Only case 1 is rejected, and the oracle deciding which case a name falls
    // in has to span every schema the parser reads. `IFC_ENTITY_NAMES` does
    // not: it is the hand-kept IFC4X3-only display-name table, and keying on
    // it rejected `IfcDoorStyle` and `IfcWindowStyle` outright. `isKnownType`
    // (@ifc-lite/parser) is the predicate that already answers this question
    // for the SDK's authoring guard - the bundled IFC2X3 + IFC4 + IFC4X3
    // schema union, minus EXPRESS defined types (`IfcLengthMeasure`,
    // `IfcArcIndex`), with the IFC4_ADD2_TC1 codegen pin as a fallback. Using
    // it rather than growing a second name table keeps one source of truth.
    //
    // `isKnownType` deliberately does not resolve `ENTITY_NAME_ALIASES`,
    // because it doubles as a name canonicalizer and an alias maps a leaf to
    // its nearest schema-known *supertype*. For a pure known-ness question the
    // alias table is exactly the right thing to consult: it lists names real
    // STEP files carry that the bundled EXPRESS exports omit, such as IFC4X3's
    // `IfcSolidStratum`, which the bundled table folds into
    // `IfcGeotechnicalStratum` with a PredefinedType. Hence the second lookup -
    // it is the difference between accepting and rejecting those names.
    // (This cited `IfcElectricalDistributionPoint` until #3172, which is not an
    // entity in any schema -- the real IFC2X3 name has no "AL", and being in
    // `ENTITIES_IFC2X3` it never needed the alias table at all.)
    //
    // A genuine query for the Unknown bucket is still made by passing the
    // literal string `'Unknown'`.
    //
    // One normalisation feeds both steps. `trim()` has to happen BEFORE the
    // enum lookup, not just inside the guard: `IfcTypeEnumFromString` only
    // uppercases, so a padded `' IfcWall '` misses `TYPE_STRING_TO_ENUM` and
    // yields `Unknown`, while the guard - trimming - finds `IfcWall` known and
    // lets it through. The query would then run against the Unknown bucket and
    // answer with entities that are not walls, with no error at all. Trimming
    // at one place only is what creates that window; trimming at both closes
    // it. For every unpadded name `trim()` is the identity, so no name that
    // resolves correctly today changes meaning.
    const typeEnums = types.map(t => {
      const trimmed = t.trim();
      const typeEnum = IfcTypeEnumFromString(trimmed);
      if (typeEnum === IfcTypeEnum.Unknown) {
        const known =
          trimmed.toUpperCase() === 'UNKNOWN' ||
          isKnownType(trimmed) ||
          isKnownType(resolveEntityNameAlias(trimmed));
        if (!known) {
          throw new Error(
            `ofType(): "${t}" is not an entity name in any IFC schema this ` +
            `build reads (IFC2X3, IFC4, IFC4X3). Check the spelling; for a ` +
            `vendor-specific type name, pass 'Unknown' to query entities ` +
            `whose type could not be classified.`
          );
        }
      }
      return typeEnum;
    });
    return new EntityQuery(this.store, typeEnums);
  }
  
  all(): EntityQuery {
    return new EntityQuery(this.store, null);
  }
  
  byId(expressId: number): EntityQuery {
    return new EntityQuery(this.store, null, [expressId]);
  }

  // ═══════════════════════════════════════════════════════════════
  // GRAPH API - Relationship traversal
  // ═══════════════════════════════════════════════════════════════
  
  entity(expressId: number): EntityNode {
    return new EntityNode(this.store, expressId);
  }

  // ═══════════════════════════════════════════════════════════════
  // SPATIAL API - Geometry-based queries
  // ═══════════════════════════════════════════════════════════════
  
  inBounds(aabb: AABB): EntityQuery {
    if (!this.store.spatialIndex) {
      throw new Error('Spatial index not available. Geometry must be processed first.');
    }
    const ids = this.store.spatialIndex.queryAABB(aabb);
    return new EntityQuery(this.store, null, ids);
  }
  
  onStorey(storeyId: number): EntityQuery {
    if (!this.store.spatialHierarchy) {
      throw new Error('Spatial hierarchy not available.');
    }
    const ids = this.store.spatialHierarchy.byStorey.get(storeyId) ?? [];
    return new EntityQuery(this.store, null, ids);
  }
  
  raycast(origin: [number, number, number], direction: [number, number, number]): number[] {
    if (!this.store.spatialIndex) {
      throw new Error('Spatial index not available. Geometry must be processed first.');
    }
    return this.store.spatialIndex.raycast(origin, direction);
  }

  // ═══════════════════════════════════════════════════════════════
  // SPATIAL HIERARCHY ACCESS
  // ═══════════════════════════════════════════════════════════════
  
  get hierarchy(): SpatialHierarchy | null {
    return this.store.spatialHierarchy ?? null;
  }
  
  get project(): EntityNode | null {
    if (!this.store.spatialHierarchy) return null;
    return this.entity(this.store.spatialHierarchy.project.expressId);
  }
  
  get storeys(): EntityNode[] {
    if (!this.store.spatialHierarchy) return [];
    return [...this.store.spatialHierarchy.byStorey.keys()]
      .sort((a, b) => {
        const elevA = this.store.spatialHierarchy!.storeyElevations.get(a) ?? 0;
        const elevB = this.store.spatialHierarchy!.storeyElevations.get(b) ?? 0;
        return elevA - elevB;
      })
      .map(id => this.entity(id));
  }
}
