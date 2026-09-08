/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Fluent query builder for entities
 */

import type { IfcStoreBase as IfcDataStore, PropertySet, QuantitySet } from '@ifc-lite/data';
import { IfcTypeEnum } from '@ifc-lite/data';
import { QueryResultEntity } from './query-result-entity.js';
import { matchesPsetFilter, matchesQsetFilter } from './property-filter.js';

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
    // Narrow to one row for this call only. `this.limit(1)` mutates the query
    // itself, so the cap outlived the call and every later
    // execute()/ids()/first() on the same object returned at most one row --
    // including one the caller had set a different limit on. Restore whatever
    // was there before rather than clearing it, so an explicit limit survives.
    const previousLimit = this.limitCount;
    this.limitCount = 1;
    try {
      const results = this.execute();
      return results[0] ?? null;
    } finally {
      this.limitCount = previousLimit;
    }
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
  
  /**
   * Narrow `ids` to those satisfying every registered property filter.
   *
   * A filter's first argument names either a property set or a quantity set,
   * so both tables are consulted and their matches unioned. Two strategies,
   * picked per store:
   *
   * - **Indexed** whenever `store.properties` does not report an explicit zero
   *   row count. It is the store that decides this, not the file format:
   *   `@ifc-lite/ifcx` builds real rows via `PropertyTableBuilder`, so an IFCX
   *   file carrying properties lands here (one carrying none still reports zero
   *   rows and takes the branch below), as does a cache written from such an
   *   already materialised store. `findByProperty` and `findByQuantity` answer off the
   *   name indices, so cost scales with the number of rows carrying that name,
   *   not with the candidate count.
   * - **Resolved sets** when the property table reports `count === 0`. A STEP
   *   parse deliberately leaves the property/quantity tables at zero rows and
   *   routes reads through the on-demand maps (issue #577), so `findByProperty`
   *   there can only ever return `[]` — which is what made `whereProperty`
   *   silently match nothing on every `.ifc` file. This also covers a
   *   **cache restored from a STEP parse**: the writer serialises
   *   `dataStore.properties` verbatim, so an empty table round-trips empty
   *   (`findByProperty` survives as a method but indexes nothing) and the
   *   viewer rebuilds the on-demand maps on restore. Since the viewer only
   *   writes caches on the `.ifc` load path, cache-restored models take this
   *   branch in practice. The server-converted viewer store also reports
   *   `count: 0` and lands here. The filter then resolves the candidates
   *   through `store.getProperties` / `store.getQuantities`, the same
   *   accessors the read path (`EntityNode.property`,
   *   `QueryResultEntity.getProperty`) uses.
   *
   * Only an *explicit* zero selects the fallback: a store whose table omits
   * `count` altogether keeps the indexed path, because every store predating
   * `count` on `IfcStoreBase` implements `findByProperty` for real.
   *
   * The fallback is candidate-scoped, never store-wide: only the ids that
   * survived the type/id filter are resolved, and each is resolved at most once
   * *per source* across all filters — `psetCache` and `qsetCache` are separate,
   * so an entity reached by both sides costs one `getProperties` and one
   * `getQuantities`, never one per filter. It is still O(candidates x source
   * extraction), so scope
   * with `ofType(...)` before `whereProperty(...)` on large models — the note in
   * `docs/guide/querying.md` says the same thing to callers.
   *
   * Matching is ANY-match: an entity passes when *any* property of that name in
   * *any* set of that name satisfies the operator. That is what
   * `PropertyTable.findByProperty` does (it walks every row of that property
   * name), so the two strategies agree with each other. It deliberately does
   * *not* agree with the single-value read path (`EntityNode.property` and
   * `QueryResultEntity.getProperty` return the *first* match), which differs
   * only for an entity carrying the same property name twice; that divergence
   * is pinned by a test in `where-property-fallback.test.ts`.
   */
  private applyPropertyFilters(ids: number[]): number[] {
    if (this.propertyFilters.length === 0) return ids;

    const properties = this.store.properties;
    const quantities = this.store.quantities;
    // Explicit zero only — see the doc comment above and the `count` contract
    // on `IfcStoreBase`'s property table.
    const useTable = properties.count !== 0;
    // The two tables choose independently. Gating the quantity side off
    // `properties.count` would mean a store that materialised one table but not
    // the other got the wrong strategy for the other: a populated property table
    // beside an empty quantity table would query an empty `findByQuantity` and
    // match no quantities at all, and the inverse would resolve candidates one
    // at a time while a populated quantity index sat unused.
    const useQuantityTable = quantities.count !== 0;
    // `quantities` and `getQuantities` are both REQUIRED on `IfcStoreBase`, so
    // neither is guarded here: a store missing either is already out of
    // contract, and half-guarding it (optional-chaining the table but calling
    // `getQuantities` unconditionally two branches down) would only move the
    // TypeError, not prevent it. `findByQuantity` is the one genuinely optional
    // member, so that is the only existence check.
    // Bound to the table so the optional method keeps its receiver.
    const findByQuantity = useQuantityTable && quantities.findByQuantity
      ? quantities.findByQuantity.bind(quantities)
      : undefined;
    // Shared across all filters: resolving a pset/qset costs a source
    // extraction on the on-demand path, so never resolve the same entity twice.
    const psetCache = new Map<number, PropertySet[]>();
    const qsetCache = new Map<number, QuantitySet[]>();

    let filteredIds = ids;

    for (const filter of this.propertyFilters) {
      const matches = new Set<number>();

      if (useTable) {
        for (const id of properties.findByProperty(filter.prop, filter.op, filter.value, filter.pset)) {
          matches.add(id);
        }
      } else {
        for (const id of filteredIds) {
          let psets = psetCache.get(id);
          if (!psets) {
            psets = this.store.getProperties(id);
            psetCache.set(id, psets);
          }
          if (matchesPsetFilter(psets, filter.pset, filter.prop, filter.op, filter.value)) matches.add(id);
        }
      }

      // Quantity side: `whereProperty('Qto_WallBaseQuantities', 'NetArea', '>', 10)`
      // is documented (docs/guide/querying.md, packages/query/README.md) but
      // quantities live in a separate table, so a Qto_ filter matched nothing on
      // every path. Union rather than "only when the property side came back
      // empty" — a conditional would drop entities matched via quantities as
      // soon as any other entity matched via properties.
      if (findByQuantity) {
        for (const id of findByQuantity(filter.prop, filter.op, filter.value, filter.pset)) {
          matches.add(id);
        }
      } else {
        // No index available: the on-demand path (where the columnar quantity
        // table is empty by construction), or a duck-typed table that does not
        // implement `findByQuantity`.
        for (const id of filteredIds) {
          if (matches.has(id)) continue;
          let qsets = qsetCache.get(id);
          if (!qsets) {
            qsets = this.store.getQuantities(id);
            qsetCache.set(id, qsets);
          }
          if (matchesQsetFilter(qsets, filter.pset, filter.prop, filter.op, filter.value)) matches.add(id);
        }
      }

      filteredIds = filteredIds.filter(id => matches.has(id));
    }

    return filteredIds;
  }
}
