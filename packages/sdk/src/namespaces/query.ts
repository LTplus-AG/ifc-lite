/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { compileNameMatcher } from '@ifc-lite/lists';
import type {
  BimBackend,
  EntityRef,
  EntityData,
  EntityAttributeData,
  PropertySetData,
  QuantitySetData,
  ClassificationData,
  MaterialData,
  TypePropertiesData,
  DocumentData,
  EntityRelationshipsData,
  QueryDescriptor,
  QueryFilter,
  ComparisonOp,
} from '../types.js';

/**
 * Chainable query builder — collects filters, executes on terminal call.
 *
 * Usage:
 *   bim.query().byType('IfcWall').where('Pset_WallCommon', 'IsExternal', '=', true).toArray()
 */
export class QueryBuilder {
  private descriptor: QueryDescriptor = {};
  private backend: BimBackend;

  constructor(backend: BimBackend) {
    this.backend = backend;
  }

  /** Scope query to a specific model */
  model(modelId: string): this {
    this.descriptor.modelId = modelId;
    return this;
  }

  /** Filter by IFC class type(s) */
  byType(...types: string[]): this {
    this.descriptor.types = [...(this.descriptor.types ?? []), ...types];
    return this;
  }

  /** Filter by property value */
  where(psetName: string, propName: string, operator?: ComparisonOp, value?: string | number | boolean): this {
    const filter: QueryFilter = {
      psetName,
      propName,
      operator: operator ?? 'exists',
      value,
    };
    this.descriptor.filters = [...(this.descriptor.filters ?? []), filter];
    return this;
  }

  /** Limit result count */
  limit(n: number): this {
    this.descriptor.limit = n;
    return this;
  }

  /** Skip first n results */
  offset(n: number): this {
    this.descriptor.offset = n;
    return this;
  }

  // ── Terminal operations ────────────────────────────────────

  /** Execute and return EntityData array */
  toArray(): EntityData[] {
    return this.backend.query.entities(this.descriptor);
  }

  /** Execute and return first match or null */
  first(): EntityData | null {
    const saved = this.descriptor.limit;
    this.descriptor.limit = 1;
    const result = this.toArray();
    this.descriptor.limit = saved;
    return result[0] ?? null;
  }

  /** Execute and return count */
  count(): number {
    return this.backend.query.entities(this.descriptor).length;
  }

  /** Execute and return just EntityRef[] (no property data) */
  refs(): EntityRef[] {
    return this.backend.query.entities(this.descriptor).map(e => e.ref);
  }
}

/** bim.query — Chainable entity queries + entity data access */
export class QueryNamespace {
  constructor(private backend: BimBackend) {}

  /** Start a new query chain */
  create(): QueryBuilder {
    return new QueryBuilder(this.backend);
  }

  /**
   * Entities matching the host's active advanced filter, or `null` when no
   * filter is active. Use for "export only the current filtered view" flows.
   */
  matchingActiveFilter(): EntityData[] | null {
    return this.backend.query.entitiesMatchingActiveFilter();
  }

  /** Get a single entity by ref */
  entity(ref: EntityRef): EntityData | null {
    return this.backend.query.entityData(ref);
  }

  /** Get all property sets for an entity */
  attributes(ref: EntityRef): EntityAttributeData[] {
    return this.backend.query.attributes(ref);
  }

  /** Get all property sets for an entity */
  properties(ref: EntityRef): PropertySetData[] {
    return this.backend.query.properties(ref);
  }

  /**
   * Get a single property value. `psetName` / `propName` accept Bonsai-style
   * `/regex/` patterns (e.g. `/Pset_.*Common/`), so one call can read across
   * several matching property sets; a plain name is an exact match. Returns the
   * first match in set/property order.
   */
  property(ref: EntityRef, psetName: string, propName: string): string | number | boolean | null {
    const psets = this.properties(ref);
    const matchSet = compileNameMatcher(psetName);
    const matchProp = compileNameMatcher(propName);
    for (const pset of psets) {
      if (!matchSet(pset.name)) continue;
      const prop = pset.properties.find(p => matchProp(p.name));
      if (prop) return prop.value ?? null;
    }
    return null;
  }

  /** Get all quantity sets for an entity */
  quantities(ref: EntityRef): QuantitySetData[] {
    return this.backend.query.quantities(ref);
  }

  /** Get all classifications for an entity */
  classifications(ref: EntityRef): ClassificationData[] {
    return this.backend.query.classifications(ref);
  }

  /** Get material assignment for an entity */
  materials(ref: EntityRef): MaterialData | null {
    return this.backend.query.materials(ref);
  }

  /** Get type-level property sets for an entity */
  typeProperties(ref: EntityRef): TypePropertiesData | null {
    return this.backend.query.typeProperties(ref);
  }

  /** Get linked documents for an entity */
  documents(ref: EntityRef): DocumentData[] {
    return this.backend.query.documents(ref);
  }

  /** Get structural relationship summary for an entity */
  relationships(ref: EntityRef): EntityRelationshipsData {
    return this.backend.query.relationships(ref);
  }

  /**
   * Get a single quantity value. Supports 2-arg (ref, quantityName) or 3-arg
   * (ref, qsetName, quantityName). Qset / quantity names accept Bonsai-style
   * `/regex/` patterns (e.g. `/Qto_.*BaseQuantities/`), so one call can read a
   * quantity across several matching sets; a plain name is an exact match.
   * Returns the first match in set/quantity order.
   */
  quantity(ref: EntityRef, qsetNameOrQuantityName: string, quantityName?: string): number | null {
    const qsets = this.quantities(ref);
    if (quantityName !== undefined) {
      // 3-arg: (ref, qsetName, quantityName)
      const matchSet = compileNameMatcher(qsetNameOrQuantityName);
      const matchQuant = compileNameMatcher(quantityName);
      for (const qset of qsets) {
        if (!matchSet(qset.name)) continue;
        const qty = qset.quantities.find(q => matchQuant(q.name));
        if (qty != null) return qty.value ?? null;
      }
      return null;
    }
    // 2-arg: (ref, quantityName) — search all qsets
    const matchQuant = compileNameMatcher(qsetNameOrQuantityName);
    for (const qset of qsets) {
      const qty = qset.quantities.find(q => matchQuant(q.name));
      if (qty != null) return qty.value ?? null;
    }
    return null;
  }

  /** Get related entities by IFC relationship type */
  related(ref: EntityRef, relType: string, direction: 'forward' | 'inverse'): EntityData[] {
    const refs = this.backend.query.related(ref, relType, direction);
    const result: EntityData[] = [];
    for (const r of refs) {
      const data = this.backend.query.entityData(r);
      if (data) result.push(data);
    }
    return result;
  }

  /** IfcRelContainedInSpatialStructure (inverse) — what spatial element contains this entity */
  containedIn(ref: EntityRef): EntityData | null {
    const refs = this.backend.query.related(ref, 'IfcRelContainedInSpatialStructure', 'inverse');
    if (refs.length === 0) return null;
    return this.backend.query.entityData(refs[0]);
  }

  /** IfcRelContainedInSpatialStructure (forward) — elements contained in this spatial element */
  contains(ref: EntityRef): EntityData[] {
    return this.related(ref, 'IfcRelContainedInSpatialStructure', 'forward');
  }

  /** IfcRelAggregates (inverse) — the whole that this entity is a part of */
  decomposedBy(ref: EntityRef): EntityData | null {
    const refs = this.backend.query.related(ref, 'IfcRelAggregates', 'inverse');
    if (refs.length === 0) return null;
    return this.backend.query.entityData(refs[0]);
  }

  /** IfcRelAggregates (forward) — parts that this entity aggregates */
  decomposes(ref: EntityRef): EntityData[] {
    return this.related(ref, 'IfcRelAggregates', 'forward');
  }

  /** Navigate up to the building storey */
  storey(ref: EntityRef): EntityData | null {
    let current = this.entity(ref);
    const visited = new Set<string>();
    while (current) {
      const key = `${current.ref.modelId}:${current.ref.expressId}`;
      if (visited.has(key)) break;
      visited.add(key);
      if (current.type === 'IfcBuildingStorey') return current;
      current = this.containedIn(current.ref) ?? this.decomposedBy(current.ref);
    }
    return null;
  }

  /** Walk the spatial/aggregation chain from an entity up to the root */
  path(ref: EntityRef): EntityData[] {
    const result: EntityData[] = [];
    let current = this.entity(ref);
    const visited = new Set<string>();
    while (current) {
      const key = `${current.ref.modelId}:${current.ref.expressId}`;
      if (visited.has(key)) break;
      visited.add(key);
      result.push(current);
      current = this.containedIn(current.ref) ?? this.decomposedBy(current.ref);
    }
    return result.reverse();
  }

  /** Get all storeys across the current model scope */
  storeys(): EntityData[] {
    return this.create().byType('IfcBuildingStorey').toArray();
  }
}
