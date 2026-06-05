/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PropertySet, PropertyValue } from './property-table.js';
import type { QuantitySet } from './quantity-table.js';
import type { Edge } from './relationship-graph.js';
import type { SpatialHierarchy, IfcEntity, IfcTypeEnum, RelationshipType } from './types.js';
import type { SpatialIndex } from './spatial-types.js';

interface ReadonlyMapLike<K, V> {
  get(key: K): V | undefined;
  has(key: K): boolean;
  [Symbol.iterator](): IterableIterator<[K, V]>;
}

interface EntityTable {
  readonly count: number;
  readonly expressId: ArrayLike<number>;
  getGlobalId(expressId: number): string;
  getName(expressId: number): string;
  getDescription(expressId: number): string;
  getObjectType(expressId: number): string;
  getTypeName(expressId: number): string;
  getByType(type: IfcTypeEnum): number[];
}

interface RelationshipEdges {
  getEdges(entityId: number, type?: RelationshipType): Edge[];
}

interface RelationshipGraph {
  forward: RelationshipEdges;
  inverse: RelationshipEdges;
  getRelated(entityId: number, relType: RelationshipType, direction: 'forward' | 'inverse'): number[];
}

interface PropertyTable {
  getForEntity(expressId: number): PropertySet[];
  getPropertyValue(expressId: number, psetName: string, propName: string): PropertyValue | null;
  findByProperty(propName: string, operator: string, value: PropertyValue): number[];
}

interface QuantityTable {
  getForEntity(expressId: number): QuantitySet[];
}

export interface IfcStoreBase {
  schemaVersion: 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';
  entityCount: number;
  fileSize: number;

  entities: EntityTable;
  relationships: RelationshipGraph;
  properties: PropertyTable;
  quantities: QuantityTable;

  entityIndex: {
    byId: ReadonlyMapLike<number, unknown>;
    byType: ReadonlyMapLike<string, number[]>;
  };

  spatialHierarchy?: SpatialHierarchy;
  spatialIndex?: SpatialIndex;

  getEntity(expressId: number): IfcEntity | null;
  getEntitiesByType(typeName: string): IfcEntity[];
  getProperties(expressId: number): PropertySet[];
  getQuantities(expressId: number): QuantitySet[];
}
