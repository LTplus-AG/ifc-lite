/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main query interface - provides multiple access patterns
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { IfcTypeEnumFromString, type SpatialHierarchy } from '@ifc-lite/data';
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
    const typeEnums = types.map(t => IfcTypeEnumFromString(t));
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
