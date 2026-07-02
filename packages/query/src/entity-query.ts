/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fluent query builder for entities
 */

import type { IfcStoreBase as IfcDataStore } from '@ifc-lite/data';
import { IfcTypeEnum } from '@ifc-lite/data';
import { QueryResultEntity } from './query-result-entity.js';

export type ComparisonOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'startsWith';

export class EntityQuery {
  private store: IfcDataStore;
  private typeFilter: IfcTypeEnum[] | null;
  private idFilter: number[] | null;
  private propertyFilters: Array<{ pset: string; prop: string; op: ComparisonOperator; value: any }> = [];
  private limitCount: number | null = null;
  private offsetCount: number = 0;
  private includeFlags: { geometry?: boolean; properties?: boolean; quantities?: boolean } = {};
  
  constructor(store: IfcDataStore, types: IfcTypeEnum[] | null, ids: number[] | null = null) {
    this.store = store;
    this.typeFilter = types;
    this.idFilter = ids;
  }

  // ═══════════════════════════════════════════════════════════════
  // FILTERING
  // ═══════════════════════════════════════════════════════════════
  
  whereProperty(psetName: string, propName: string, operator: ComparisonOperator, value: any): this {
    this.propertyFilters.push({ pset: psetName, prop: propName, op: operator, value });
    return this;
  }
  
  limit(count: number): this {
    this.limitCount = count;
    return this;
  }
  
  offset(count: number): this {
    this.offsetCount = count;
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // EAGER LOADING
  // ═══════════════════════════════════════════════════════════════
  
  includeGeometry(): this {
    this.includeFlags.geometry = true;
    return this;
  }
  
  includeProperties(): this {
    this.includeFlags.properties = true;
    return this;
  }
  
  includeQuantities(): this {
    this.includeFlags.quantities = true;
    return this;
  }
  
  includeAll(): this {
    this.includeFlags = { geometry: true, properties: true, quantities: true };
    return this;
  }

  // ═══════════════════════════════════════════════════════════════
  // EXECUTION
  // ═══════════════════════════════════════════════════════════════
  
  execute(): QueryResultEntity[] {
    let ids = this.getCandidateIds();
    ids = this.applyPropertyFilters(ids);
    
    if (this.offsetCount > 0) {
      ids = ids.slice(this.offsetCount);
    }
    if (this.limitCount !== null) {
      ids = ids.slice(0, this.limitCount);
    }
    
    const results = ids.map(id => new QueryResultEntity(this.store, id, this.includeFlags));
    
    // Eager load based on flags
    for (const result of results) {
      if (this.includeFlags.properties) {
        result.loadProperties();
      }
      if (this.includeFlags.quantities) {
        result.loadQuantities();
      }
      if (this.includeFlags.geometry) {
        result.loadGeometry();
      }
    }
    
    return results;
  }
  
  async ids(): Promise<number[]> {
    let ids = this.getCandidateIds();
    ids = this.applyPropertyFilters(ids);
    if (this.offsetCount > 0) ids = ids.slice(this.offsetCount);
    if (this.limitCount !== null) ids = ids.slice(0, this.limitCount);
    return ids;
  }
  
  async count(): Promise<number> {
    let ids = this.getCandidateIds();
    ids = this.applyPropertyFilters(ids);
    return ids.length;
  }
  
  async first(): Promise<QueryResultEntity | null> {
    const results = this.limit(1).execute();
    return results[0] ?? null;
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════
  
  private getCandidateIds(): number[] {
    if (this.idFilter) return [...this.idFilter];
    if (this.typeFilter) {
      const ids: number[] = [];
      for (const typeEnum of this.typeFilter) {
        ids.push(...this.store.entities.getByType(typeEnum));
      }
      return ids;
    }
    // Return all entity IDs
    const allIds: number[] = [];
    for (let i = 0; i < this.store.entities.count; i++) {
      allIds.push(this.store.entities.expressId[i]);
    }
    return allIds;
  }
  
  private applyPropertyFilters(ids: number[]): number[] {
    if (this.propertyFilters.length === 0) return ids;
    
    let filteredIds = ids;
    
    for (const filter of this.propertyFilters) {
      const matchingIds = this.store.properties.findByProperty(
        filter.prop,
        filter.op,
        filter.value,
        filter.pset,
      );
      const matchingSet = new Set(matchingIds);
      filteredIds = filteredIds.filter(id => matchingSet.has(id));
    }
    
    return filteredIds;
  }
}
