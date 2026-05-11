/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Worker-boundary transport for `IfcDataStore`.
 *
 * `IfcDataStore` carries closures (`entities.getName`, `relationships.getRelated`,
 * `spatialHierarchy.getPath`, …) that the structured-clone algorithm strips
 * silently. This module separates the clone-safe column data from the
 * closures: `toTransport` returns a POJO + transferable list to ship across
 * a `postMessage` boundary; `fromTransport` reconstructs a live `IfcDataStore`
 * with closures rebuilt on the receiving thread.
 *
 * The `source` buffer is intentionally NOT included in the transferable list
 * because both the parser worker and the geometry workers read from the same
 * `SharedArrayBuffer` upstream of the parser. Callers are responsible for
 * keeping a `Uint8Array` view of that SAB on the main thread and supplying
 * it to `fromTransport`.
 */

import {
  type EntityTable,
  type EntityTableColumns,
  type PropertyTable,
  type PropertyTableColumns,
  type QuantityTable,
  type QuantityTableColumns,
  type RelationshipGraph,
  type RelationshipGraphColumns,
  type SpatialHierarchy,
  type SpatialNode,
  type StringTable as DataStringTable,
  IfcTypeEnum,
  StringTable,
  entityTableFromColumns,
  entityTableToColumns,
  propertyTableFromColumns,
  propertyTableToColumns,
  quantityTableFromColumns,
  quantityTableToColumns,
  relationshipGraphFromColumns,
  relationshipGraphToColumns,
} from '@ifc-lite/data';

import { CompactEntityIndex } from './compact-entity-index.js';
import type { EntityRef } from './types.js';
import type { IfcDataStore, EntityByIdIndex } from './columnar-parser.js';

// ────────────────────────────────────────────────────────────────────────────
// CompactEntityIndex transport
// ────────────────────────────────────────────────────────────────────────────

/**
 * Plain-data column representation of a `CompactEntityIndex`. Holds the
 * five backing arrays plus the deduplicated type-string list. All four
 * typed arrays are transferable.
 */
export interface CompactEntityIndexColumns {
  expressIds: Uint32Array;
  byteOffsets: Uint32Array;
  byteLengths: Uint32Array;
  typeIndices: Uint16Array;
  typeStrings: string[];
}

function compactEntityIndexToColumns(index: CompactEntityIndex): CompactEntityIndexColumns {
  // CompactEntityIndex stores its arrays as private fields; access them
  // through the prototype's documented columns. We rely on the public
  // constructor's parameter order to define this contract.
  const internal = index as unknown as {
    expressIds: Uint32Array;
    byteOffsets: Uint32Array;
    byteLengths: Uint32Array;
    typeIndices: Uint16Array;
    typeStrings: string[];
  };
  return {
    expressIds: internal.expressIds,
    byteOffsets: internal.byteOffsets,
    byteLengths: internal.byteLengths,
    typeIndices: internal.typeIndices,
    typeStrings: internal.typeStrings.slice(),
  };
}

function compactEntityIndexFromColumns(columns: CompactEntityIndexColumns): CompactEntityIndex {
  return new CompactEntityIndex(
    columns.expressIds,
    columns.byteOffsets,
    columns.byteLengths,
    columns.typeIndices,
    columns.typeStrings,
  );
}

// ────────────────────────────────────────────────────────────────────────────
// SpatialHierarchy transport
//
// SpatialHierarchy is a tree of plain objects + Maps + closures. We
// serialize the tree + maps (no closures), then rebuild closures on the
// receiving thread with the same algorithms desktop snapshot hydration uses.
// ────────────────────────────────────────────────────────────────────────────

interface SerializedSpatialNode {
  expressId: number;
  type: number;
  name: string;
  elevation?: number;
  children: SerializedSpatialNode[];
  elements: number[];
}

export interface SpatialHierarchyColumns {
  project: SerializedSpatialNode;
  byStorey: Array<[number, number[]]>;
  byBuilding: Array<[number, number[]]>;
  bySite: Array<[number, number[]]>;
  bySpace: Array<[number, number[]]>;
  storeyElevations: Array<[number, number]>;
  storeyHeights: Array<[number, number]>;
  elementToStorey: Array<[number, number]>;
}

function serializeSpatialNode(node: SpatialNode): SerializedSpatialNode {
  return {
    expressId: node.expressId,
    type: node.type,
    name: node.name,
    elevation: node.elevation,
    children: node.children.map(serializeSpatialNode),
    elements: [...node.elements],
  };
}

function deserializeSpatialNode(node: SerializedSpatialNode): SpatialNode {
  return {
    expressId: node.expressId,
    type: node.type as IfcTypeEnum,
    name: node.name,
    elevation: node.elevation,
    children: node.children.map(deserializeSpatialNode),
    elements: [...node.elements],
  };
}

export function spatialHierarchyToColumns(hierarchy: SpatialHierarchy): SpatialHierarchyColumns {
  return {
    project: serializeSpatialNode(hierarchy.project),
    byStorey: [...hierarchy.byStorey.entries()].map(([id, els]) => [id, [...els]]),
    byBuilding: [...hierarchy.byBuilding.entries()].map(([id, els]) => [id, [...els]]),
    bySite: [...hierarchy.bySite.entries()].map(([id, els]) => [id, [...els]]),
    bySpace: [...hierarchy.bySpace.entries()].map(([id, els]) => [id, [...els]]),
    storeyElevations: [...hierarchy.storeyElevations.entries()],
    storeyHeights: [...hierarchy.storeyHeights.entries()],
    elementToStorey: [...hierarchy.elementToStorey.entries()],
  };
}

export function spatialHierarchyFromColumns(columns: SpatialHierarchyColumns): SpatialHierarchy {
  const project = deserializeSpatialNode(columns.project);
  const byStorey = new Map<number, number[]>(columns.byStorey.map(([id, els]) => [id, [...els]]));
  const byBuilding = new Map<number, number[]>(columns.byBuilding.map(([id, els]) => [id, [...els]]));
  const bySite = new Map<number, number[]>(columns.bySite.map(([id, els]) => [id, [...els]]));
  const bySpace = new Map<number, number[]>(columns.bySpace.map(([id, els]) => [id, [...els]]));
  const storeyElevations = new Map<number, number>(columns.storeyElevations);
  const storeyHeights = new Map<number, number>(columns.storeyHeights);
  const elementToStorey = new Map<number, number>(columns.elementToStorey);

  // elementToSpace is the inverse of bySpace and is what `getContainingSpace`
  // queries. Only this direction is shipped over the wire because it is
  // O(unique-spaces) and trivially derivable from `bySpace`.
  const elementToSpace = new Map<number, number>();
  for (const [spaceId, elementIds] of bySpace) {
    for (const elementId of elementIds) {
      elementToSpace.set(elementId, spaceId);
    }
  }

  return {
    project,
    byStorey,
    byBuilding,
    bySite,
    bySpace,
    storeyElevations,
    storeyHeights,
    elementToStorey,

    getStoreyElements(storeyId: number): number[] {
      return byStorey.get(storeyId) ?? [];
    },
    getStoreyByElevation(z: number): number | null {
      let best: number | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const [storeyId, elevation] of storeyElevations) {
        const distance = Math.abs(elevation - z);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = storeyId;
        }
      }
      return best;
    },
    getContainingSpace(elementId: number): number | null {
      return elementToSpace.get(elementId) ?? null;
    },
    getPath(elementId: number): SpatialNode[] {
      const path: SpatialNode[] = [];
      const walk = (node: SpatialNode): boolean => {
        path.push(node);
        if (node.elements.includes(elementId)) return true;
        for (const child of node.children) {
          if (walk(child)) return true;
        }
        path.pop();
        return false;
      };
      walk(project);
      return path;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Memory snapshot helper (parser worker → main)
// ────────────────────────────────────────────────────────────────────────────

export interface ParserMemorySnapshot {
  /** `performance.memory.usedJSHeapSize` from inside the parser worker (Chromium). */
  jsHeapBytes?: number;
  /** Per-realm bytes from `performance.measureUserAgentSpecificMemory()` (cross-origin-isolated). */
  uaMemoryBytes?: number;
  /** Total byte length of all transferable typed arrays in the payload. */
  transportBytes: number;
  /** Source buffer byteLength (unchanged by parse, included for the receiver's overall accounting). */
  sourceBytes: number;
  /** Wall-clock parse duration in milliseconds. */
  parseTimeMs: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Top-level transport payload
// ────────────────────────────────────────────────────────────────────────────

export interface DataStoreTransport {
  fileSize: number;
  schemaVersion: IfcDataStore['schemaVersion'];
  entityCount: number;
  parseTime: number;

  entityIndex: {
    byId: CompactEntityIndexColumns;
    byType: Array<[string, number[]]>;
  };
  deferredEntityIndex?: CompactEntityIndexColumns;

  strings: string[];
  entities: EntityTableColumns;
  properties: PropertyTableColumns;
  quantities: QuantityTableColumns;
  relationships: RelationshipGraphColumns;

  spatialHierarchy?: SpatialHierarchyColumns;

  onDemandPropertyMap: Array<[number, number[]]>;
  onDemandQuantityMap: Array<[number, number[]]>;
  onDemandClassificationMap: Array<[number, number[]]>;
  onDemandMaterialMap: Array<[number, number]>;
  onDemandDocumentMap: Array<[number, number[]]>;

  memory?: ParserMemorySnapshot;
}

/**
 * Shape of the value `toTransport` returns: the cloneable payload plus the
 * list of `Transferable` buffers that should be moved (rather than copied)
 * via `postMessage(payload, transfers)`.
 */
export interface DataStoreTransportEnvelope {
  payload: DataStoreTransport;
  transfers: Transferable[];
}

/**
 * Pull every typed-array buffer out of a `DataStoreTransport` into a flat
 * array suitable for the `postMessage` transfer list. Order is not
 * meaningful — the structured-clone algorithm matches by buffer identity.
 *
 * Exported so the parser worker can append additional buffers (e.g. memory
 * snapshot byte arrays) before posting.
 */
export function collectTransferables(payload: DataStoreTransport): Transferable[] {
  const list: Transferable[] = [];
  const push = (buf: ArrayBufferLike | undefined): void => {
    if (buf && buf instanceof ArrayBuffer) list.push(buf);
  };

  push(payload.entityIndex.byId.expressIds.buffer);
  push(payload.entityIndex.byId.byteOffsets.buffer);
  push(payload.entityIndex.byId.byteLengths.buffer);
  push(payload.entityIndex.byId.typeIndices.buffer);

  if (payload.deferredEntityIndex) {
    push(payload.deferredEntityIndex.expressIds.buffer);
    push(payload.deferredEntityIndex.byteOffsets.buffer);
    push(payload.deferredEntityIndex.byteLengths.buffer);
    push(payload.deferredEntityIndex.typeIndices.buffer);
  }

  // EntityTableColumns
  for (const arr of [
    payload.entities.expressId,
    payload.entities.typeEnum,
    payload.entities.globalId,
    payload.entities.name,
    payload.entities.description,
    payload.entities.objectType,
    payload.entities.flags,
    payload.entities.containedInStorey,
    payload.entities.definedByType,
    payload.entities.geometryIndex,
  ]) push(arr.buffer);
  if (payload.entities.rawTypeName) push(payload.entities.rawTypeName.buffer);

  // PropertyTableColumns
  for (const arr of [
    payload.properties.entityId,
    payload.properties.psetName,
    payload.properties.psetGlobalId,
    payload.properties.propName,
    payload.properties.propType,
    payload.properties.valueString,
    payload.properties.valueReal,
    payload.properties.valueInt,
    payload.properties.valueBool,
    payload.properties.unitId,
  ]) push(arr.buffer);

  // QuantityTableColumns
  for (const arr of [
    payload.quantities.entityId,
    payload.quantities.qsetName,
    payload.quantities.quantityName,
    payload.quantities.quantityType,
    payload.quantities.value,
    payload.quantities.unitId,
    payload.quantities.formula,
  ]) push(arr.buffer);

  // RelationshipGraphColumns
  for (const half of [payload.relationships.forward, payload.relationships.inverse]) {
    push(half.edgeTargets.buffer);
    push(half.edgeTypes.buffer);
    push(half.edgeRelIds.buffer);
  }

  // De-duplicate: a typed array sliced from another aliases the same
  // buffer, and listing the same Transferable twice throws.
  const seen = new Set<Transferable>();
  const unique: Transferable[] = [];
  for (const t of list) {
    if (!seen.has(t)) {
      seen.add(t);
      unique.push(t);
    }
  }
  return unique;
}

function sumBytes(payload: DataStoreTransport): number {
  let total = 0;
  for (const transferable of collectTransferables(payload)) {
    if (transferable instanceof ArrayBuffer) total += transferable.byteLength;
  }
  return total;
}

/**
 * Convert a live `IfcDataStore` into a structured-clone-safe payload plus a
 * list of buffers to move via `postMessage(payload, transfers)`.
 *
 * `source` is dropped from the payload because the parser worker and main
 * thread both view the same upstream `SharedArrayBuffer`. Callers must
 * reattach `source` on the receiving side when calling `fromTransport`.
 */
export function toTransport(store: IfcDataStore): DataStoreTransportEnvelope {
  const byTypeEntries: Array<[string, number[]]> = [];
  for (const [key, value] of store.entityIndex.byType) {
    byTypeEntries.push([key, [...value]]);
  }

  const compactById = store.entityIndex.byId as unknown;
  if (!(compactById instanceof CompactEntityIndex)) {
    throw new Error('toTransport requires CompactEntityIndex (the lite parser path always provides one)');
  }

  const payload: DataStoreTransport = {
    fileSize: store.fileSize,
    schemaVersion: store.schemaVersion,
    entityCount: store.entityCount,
    parseTime: store.parseTime,

    entityIndex: {
      byId: compactEntityIndexToColumns(compactById),
      byType: byTypeEntries,
    },
    deferredEntityIndex: store.deferredEntityIndex instanceof CompactEntityIndex
      ? compactEntityIndexToColumns(store.deferredEntityIndex)
      : undefined,

    strings: store.strings.getAll(),
    entities: entityTableToColumns(store.entities),
    properties: propertyTableToColumns(store.properties),
    quantities: quantityTableToColumns(store.quantities),
    relationships: relationshipGraphToColumns(store.relationships),

    spatialHierarchy: store.spatialHierarchy
      ? spatialHierarchyToColumns(store.spatialHierarchy)
      : undefined,

    onDemandPropertyMap: store.onDemandPropertyMap
      ? [...store.onDemandPropertyMap.entries()].map(([k, v]) => [k, [...v]])
      : [],
    onDemandQuantityMap: store.onDemandQuantityMap
      ? [...store.onDemandQuantityMap.entries()].map(([k, v]) => [k, [...v]])
      : [],
    onDemandClassificationMap: store.onDemandClassificationMap
      ? [...store.onDemandClassificationMap.entries()].map(([k, v]) => [k, [...v]])
      : [],
    onDemandMaterialMap: store.onDemandMaterialMap
      ? [...store.onDemandMaterialMap.entries()]
      : [],
    onDemandDocumentMap: store.onDemandDocumentMap
      ? [...store.onDemandDocumentMap.entries()].map(([k, v]) => [k, [...v]])
      : [],
  };

  return { payload, transfers: collectTransferables(payload) };
}

/**
 * Reconstruct a live `IfcDataStore` (closures rebuilt) from a
 * `DataStoreTransport` payload and the `source` buffer view that lives on
 * the receiving thread.
 */
export function fromTransport(payload: DataStoreTransport, source: Uint8Array): IfcDataStore {
  const strings: DataStringTable = StringTable.fromArray(payload.strings);
  const entities = entityTableFromColumns(payload.entities, strings);
  const properties = propertyTableFromColumns(payload.properties, strings);
  const quantities = quantityTableFromColumns(payload.quantities, strings);
  const relationships = relationshipGraphFromColumns(payload.relationships);

  const byIdIndex = compactEntityIndexFromColumns(payload.entityIndex.byId);
  const byType = new Map<string, number[]>(
    payload.entityIndex.byType.map(([k, v]) => [k, [...v]]),
  );
  const deferredEntityIndex = payload.deferredEntityIndex
    ? compactEntityIndexFromColumns(payload.deferredEntityIndex)
    : undefined;

  const spatialHierarchy = payload.spatialHierarchy
    ? spatialHierarchyFromColumns(payload.spatialHierarchy)
    : undefined;

  const store: IfcDataStore = {
    fileSize: payload.fileSize,
    schemaVersion: payload.schemaVersion,
    entityCount: payload.entityCount,
    parseTime: payload.parseTime,

    source,
    entityIndex: {
      byId: byIdIndex as unknown as EntityByIdIndex,
      byType,
    },
    deferredEntityIndex: deferredEntityIndex as unknown as EntityByIdIndex | undefined,

    strings,
    entities,
    properties,
    quantities,
    relationships,
    spatialHierarchy,

    onDemandPropertyMap: new Map(payload.onDemandPropertyMap.map(([k, v]) => [k, [...v]])),
    onDemandQuantityMap: new Map(payload.onDemandQuantityMap.map(([k, v]) => [k, [...v]])),
    onDemandClassificationMap: new Map(payload.onDemandClassificationMap.map(([k, v]) => [k, [...v]])),
    onDemandMaterialMap: new Map(payload.onDemandMaterialMap),
    onDemandDocumentMap: new Map(payload.onDemandDocumentMap.map(([k, v]) => [k, [...v]])),
  };
  return store;
}

/**
 * Convenience: compute the byte-size of the transferable payload so the
 * receiver can record it in the memory accounting snapshot.
 */
export function transportByteSize(payload: DataStoreTransport): number {
  return sumBytes(payload);
}

// Internal type re-exports for tests and adjacent worker code.
export type { EntityTable, PropertyTable, QuantityTable, RelationshipGraph, SpatialHierarchy };

// Helper used by the worker init handshake: the worker needs to know
// what an EntityRef looks like when it builds intermediate results.
export type { EntityRef };
