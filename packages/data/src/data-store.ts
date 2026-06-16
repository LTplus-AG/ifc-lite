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

/**
 * Verbatim HEADER fields captured from a parsed IFC file so a round-trip
 * export can reproduce them instead of regenerating a fresh ifc-lite header.
 *
 * `FILE_DESCRIPTION` is informational metadata under ISO 10303-21 (no schema
 * or validation semantics), but rewriting it on every round-trip silently
 * drops the source's `ViewDefinition [...]` label and vendor identifier
 * strings. Capturing these lets the exporter preserve them while still being
 * honest that ifc-lite processed the file (see the STEP exporter's provenance
 * handling). Values are STEP-decoded strings; the exporter re-escapes them.
 */
export interface IfcSourceHeader {
  /** Raw description items from `FILE_DESCRIPTION`, in order. */
  description: string[];
  /** implementation_level token, e.g. `'2;1'`. */
  implementationLevel: string;
  /** FILE_NAME `name` field (informational; not re-emitted verbatim). */
  name?: string;
  /** FILE_NAME `time_stamp` field (informational; not re-emitted verbatim). */
  timeStamp?: string;
  /** FILE_NAME `author` list. */
  author: string[];
  /** FILE_NAME `organization` list. */
  organization: string[];
  /** FILE_NAME `preprocessor_version` field. */
  preprocessorVersion?: string;
  /** FILE_NAME `originating_system` field. */
  originatingSystem?: string;
  /** FILE_NAME `authorization` field. */
  authorization?: string;
  /** Exact `FILE_SCHEMA` token(s) as written, e.g. `['IFC4X3_ADD2']`. */
  schemaIdentifiers: string[];
}

export interface IfcStoreBase {
  schemaVersion: 'IFC2X3' | 'IFC4' | 'IFC4X3' | 'IFC5';
  entityCount: number;
  fileSize: number;

  /**
   * Verbatim HEADER fields from the source file, when this store was built by
   * parsing a STEP/IFC file. Absent for created-from-scratch models. Lets a
   * round-trip export preserve the original `FILE_DESCRIPTION` items and the
   * exact `FILE_SCHEMA` token (e.g. `IFC4X3_ADD2`).
   */
  sourceHeader?: IfcSourceHeader;

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
