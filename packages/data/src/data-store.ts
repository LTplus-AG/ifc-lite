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

/**
 * The structural minimum a store's property table must satisfy — deliberately
 * narrower than the columnar `PropertyTable` in `property-table.ts` so that
 * duck-typed stores (server-converted, cache-restored, synthetic) can satisfy
 * `IfcStoreBase` without owning TypedArray columns.
 *
 * `count` is the number of materialised rows, and it is optional because a
 * duck-typed table need not track one. Consumers may therefore only read an
 * **explicit `count === 0`** as "this table has no rows and so cannot answer
 * `findByProperty`" — a STEP parse leaves the table empty on purpose and reads
 * through `IfcStoreBase.getProperties` instead (issue #577). An absent `count`
 * says nothing and must be treated as "ask `findByProperty`", because every
 * store written before `count` existed on this interface implements
 * `findByProperty` for real.
 */
interface PropertyTable {
  readonly count?: number;
  getForEntity(expressId: number): PropertySet[];
  getPropertyValue(expressId: number, psetName: string, propName: string): PropertyValue | null;
  findByProperty(
    propName: string,
    operator: string,
    value: PropertyValue,
    psetName?: string,
  ): number[];
}

/** Structural minimum for a store's quantity table; see {@link PropertyTable}. */
interface QuantityTable {
  readonly count?: number;
  getForEntity(expressId: number): QuantitySet[];
  /**
   * Indexed quantity filter, mirroring `PropertyTable.findByProperty`. Optional:
   * a table that omits it is resolved per candidate through
   * `IfcStoreBase.getQuantities` instead — the same answer, more work. See the
   * columnar implementation in `quantity-table.ts`.
   */
  findByQuantity?(
    quantityName: string,
    operator: string,
    value: PropertyValue,
    qsetName?: string,
  ): number[];
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
