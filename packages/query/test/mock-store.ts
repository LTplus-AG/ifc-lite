/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Minimal mock of IfcDataStore for unit testing the query package.
 * Avoids transitive dependency on WASM / parser internals.
 */

import {
  StringTable,
  EntityTableBuilder,
  PropertyTableBuilder,
  QuantityTableBuilder,
  RelationshipGraphBuilder,
  IfcTypeEnum,
  RelationshipType,
  PropertyValueType,
  QuantityType,
} from '@ifc-lite/data';

export {
  IfcTypeEnum,
  RelationshipType,
  PropertyValueType,
  QuantityType,
};

export interface MockEntity {
  expressId: number;
  type: string;
  globalId: string;
  name: string;
  description?: string;
  objectType?: string;
  hasGeometry?: boolean;
}

export interface MockProperty {
  entityId: number;
  psetName: string;
  psetGlobalId?: string;
  propName: string;
  propType: PropertyValueType;
  value: string | number | boolean | null;
}

export interface MockQuantity {
  entityId: number;
  qsetName: string;
  quantityName: string;
  quantityType: QuantityType;
  value: number;
}

export interface MockRelationship {
  source: number;
  target: number;
  type: RelationshipType;
  relId: number;
}

export interface MockStoreOptions {
  entities?: MockEntity[];
  properties?: MockProperty[];
  quantities?: MockQuantity[];
  relationships?: MockRelationship[];
}

/**
 * Build a fully functional (but minimal) IfcDataStore from simple descriptors.
 * The returned object is duck-typed to match IfcDataStore's shape as consumed
 * by EntityQuery, EntityNode, QueryResultEntity, and IfcQuery.
 */
export function createMockStore(opts: MockStoreOptions = {}) {
  const strings = new StringTable();
  const entityBuilder = new EntityTableBuilder(
    Math.max((opts.entities?.length ?? 0) + 1, 16),
    strings,
  );
  const propertyBuilder = new PropertyTableBuilder(strings);
  const quantityBuilder = new QuantityTableBuilder(strings);
  const relBuilder = new RelationshipGraphBuilder();

  for (const e of opts.entities ?? []) {
    entityBuilder.add(
      e.expressId,
      e.type.toUpperCase(),
      e.globalId,
      e.name,
      e.description ?? '',
      e.objectType ?? '',
      e.hasGeometry ?? false,
    );
  }

  for (const p of opts.properties ?? []) {
    propertyBuilder.add({
      entityId: p.entityId,
      psetName: p.psetName,
      psetGlobalId: p.psetGlobalId ?? '',
      propName: p.propName,
      propType: p.propType,
      value: p.value,
    });
  }

  for (const q of opts.quantities ?? []) {
    quantityBuilder.add({
      entityId: q.entityId,
      qsetName: q.qsetName,
      quantityName: q.quantityName,
      quantityType: q.quantityType,
      value: q.value,
    });
  }

  for (const r of opts.relationships ?? []) {
    relBuilder.addEdge(r.source, r.target, r.type, r.relId);
  }

  const entities = entityBuilder.build();
  const properties = propertyBuilder.build();
  const quantities = quantityBuilder.build();
  const relationships = relBuilder.build();

  // Build entity index matching IfcDataStore shape
  const byId = new Map<number, { expressId: number; type: string; byteOffset: number; byteLength: number; lineNumber: number }>();
  const byType = new Map<string, number[]>();
  for (const e of opts.entities ?? []) {
    const upper = e.type.toUpperCase();
    byId.set(e.expressId, { expressId: e.expressId, type: upper, byteOffset: 0, byteLength: 0, lineNumber: 0 });
    if (!byType.has(upper)) byType.set(upper, []);
    byType.get(upper)!.push(e.expressId);
  }

  return {
    fileSize: 0,
    schemaVersion: 'IFC4' as const,
    entityCount: opts.entities?.length ?? 0,
    parseTime: 0,

    source: null as unknown as Uint8Array,
    entityIndex: { byId, byType },

    strings,
    entities,
    properties,
    quantities,
    relationships,

    // These are optional on IfcDataStore and can be undefined for mock
    spatialHierarchy: undefined,
    spatialIndex: undefined,
    onDemandPropertyMap: undefined,
    onDemandQuantityMap: undefined,
    onDemandClassificationMap: undefined,
    onDemandMaterialMap: undefined,
    onDemandDocumentMap: undefined,
  };
}
