/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main query interface - provides multiple access patterns
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import {
  IFC_ENTITY_NAMES,
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
    //  1. A typo (`ofType('IfcWal')`). `IfcWal` is not an IFC entity name at
    //     all, so the caller can only have meant `IfcWall`. Left unchecked the
    //     query silently returns the Unknown bucket - every entity the store
    //     itself could not classify - which is neither the caller's wall nor
    //     an empty result, but some other, unrelated set of entities.
    //
    //  2. A real IFC entity name that `TYPE_STRING_TO_ENUM` (data/types.ts)
    //     simply has no entry for. That table is a curated subset, so standard
    //     IFC4/IFC4X3 types such as `IfcChiller`, `IfcActuator` or
    //     `IfcBuildingSystem` map to `Unknown` too. For those the Unknown
    //     bucket is the only representation available and querying it is the
    //     documented, working behaviour - a file whose sole unclassified
    //     entities are chillers really does answer `ofType('IfcChiller')`
    //     correctly this way.
    //
    // Only case 1 is rejected. `IFC_ENTITY_NAMES` (the ~880-entry IFC4X3
    // entity-name table in @ifc-lite/data) is the oracle for "is this a real
    // IFC entity name", so case 2 keeps falling through to Unknown unchanged.
    // A genuine query for the Unknown bucket is still made by passing the
    // literal string `'Unknown'`.
    const typeEnums = types.map(t => {
      const typeEnum = IfcTypeEnumFromString(t);
      if (typeEnum === IfcTypeEnum.Unknown) {
        const upper = t.trim().toUpperCase();
        if (upper !== 'UNKNOWN' && IFC_ENTITY_NAMES[upper] === undefined) {
          throw new Error(
            `ofType(): "${t}" is not an IFC entity name - check the spelling. ` +
            `To query entities whose type could not be classified, pass 'Unknown'.`
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
