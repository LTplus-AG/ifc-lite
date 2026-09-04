/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Relationship graph - bidirectional graph using CSR format
 * Enables fast traversal in both directions
 */

import { RelationshipType } from './types.js';
import { binarySearchU32, buildShadowedColumns } from './relationship-graph-helpers.js';

export interface Edge {
  target: number;
  type: RelationshipType;
  relationshipId: number;
  /**
   * Express ids of other `IfcRel*` instances that named the same
   * (source, target, type) triple and were collapsed into this edge by the
   * dedupe in `RelationshipGraphBuilder.addEdge` (#3760). A consumer that
   * needs to know whether the *connection* still exists after a delete —
   * not just whether `relationshipId` was deleted — must check these too:
   * use `edgeSurvives` (`relationship-graph-helpers.js`) rather than
   * testing `relationshipId` alone. Invariant: present implies non-empty —
   * `undefined` means "nothing collapsed into this edge", never `[]`.
   */
  shadowedRelationshipIds?: number[];
}

export interface RelationshipEdges {
  offsets: Map<number, number>;
  counts: Map<number, number>;
  edgeTargets: Uint32Array;
  edgeTypes: Uint16Array;
  edgeRelIds: Uint32Array;
  /**
   * Sparse "shadowed" ids collapsed by the (source, target, type) dedupe
   * (#3760/#3782): three small, Transferable typed arrays rather than one
   * `(number[] | undefined)[]` slot per edge — the dense shape
   * structured-clones (not transfers) across the worker boundary, measured
   * +1.2s/+190MB on a 12M-edge model for a field that's empty almost
   * everywhere. `shadowedEdgeIndex[g]` (ascending) names the edge whose ids
   * live at `shadowedRelIds[shadowedGroupOffsets[g]..shadowedGroupOffsets[g+1])`.
   * Absent together when nothing was collapsed — read via `?.`.
   */
  shadowedEdgeIndex?: Uint32Array;
  shadowedGroupOffsets?: Uint32Array;
  shadowedRelIds?: Uint32Array;

  getEdges(entityId: number, type?: RelationshipType): Edge[];
  getTargets(entityId: number, type?: RelationshipType): number[];
  hasAnyEdges(entityId: number): boolean;
}

export interface RelationshipGraph {
  forward: RelationshipEdges;
  inverse: RelationshipEdges;

  getRelated(entityId: number, relType: RelationshipType, direction: 'forward' | 'inverse'): number[];
  hasRelationship(sourceId: number, targetId: number, relType?: RelationshipType): boolean;
  getRelationshipsBetween(sourceId: number, targetId: number): RelationshipInfo[];
}

export interface RelationshipInfo {
  relationshipId: number;
  type: RelationshipType;
  typeName: string;
  /** See `Edge.shadowedRelationshipIds`. */
  shadowedRelationshipIds?: number[];
}

/**
 * Structure-of-Arrays relationship graph builder.
 * Uses parallel number arrays instead of object arrays to avoid millions of
 * small object allocations. Build phase uses counting sort (O(n)) instead
 * of comparison sort (O(n log n)) for massive speedup on large files.
 */
/** Multiplier that keeps `type` in its own digit range of the dedupe key. */
const TYPE_SPAN = 1 << 16;

export class RelationshipGraphBuilder {
  private _sources: number[] = [];
  private _targets: number[] = [];
  private _types: number[] = [];
  private _relIds: number[] = [];
  /**
   * Extra `IfcRel*` ids collapsed into an already-recorded edge, keyed by
   * that edge's index in `_sources`/`_targets`/`_types`/`_relIds`. Sparse —
   * only entities with an actual duplicate get an entry — rather than a
   * slot per edge, so a builder that never sees a duplicate pays nothing
   * for this beyond one empty `Map`.
   */
  private _shadowedRelIds = new Map<number, number[]>();

  /**
   * Edges already recorded, keyed by source, then by `target * TYPE_SPAN + type`,
   * mapping to the edge's index in `_sources`/`_targets`/`_types`/`_relIds`.
   * Nothing in EXPRESS forbids two `IfcRel*` instances from naming the same
   * (relating, related) pair, so a schema-legal file can hand us the same edge
   * twice; every consumer that walks the raw edge list would then count the
   * target twice (#3760).
   */
  private _seen = new Map<number, Map<number, number>>();

  /**
   * Adds one edge, folding a repeat of a `(source, target, type)` triple
   * already present into the surviving edge instead of dropping it outright.
   * The first instance's express id becomes `relationshipId`; later repeats
   * are kept in `_shadowedRelIds` so deleting one of several `IfcRel*`
   * instances that named the same pair doesn't make the connection
   * disappear while a sibling instance still exists (#3782 review).
   */
  addEdge(source: number, target: number, type: RelationshipType, relId: number): void {
    let seenForSource = this._seen.get(source);
    if (seenForSource === undefined) {
      seenForSource = new Map<number, number>();
      this._seen.set(source, seenForSource);
    }
    // Express ids are u32, so this stays well inside Number.MAX_SAFE_INTEGER.
    const key = target * TYPE_SPAN + type;
    const existingIndex = seenForSource.get(key);
    if (existingIndex !== undefined) {
      let shadowed = this._shadowedRelIds.get(existingIndex);
      if (shadowed === undefined) {
        shadowed = [];
        this._shadowedRelIds.set(existingIndex, shadowed);
      }
      shadowed.push(relId);
      return;
    }
    seenForSource.set(key, this._sources.length);

    this._sources.push(source);
    this._targets.push(target);
    this._types.push(type);
    this._relIds.push(relId);
  }

  build(): RelationshipGraph {
    const n = this._sources.length;
    const forward = buildCSR(n, this._sources, this._targets, this._types, this._relIds, this._shadowedRelIds);
    const inverse = buildCSR(n, this._targets, this._sources, this._types, this._relIds, this._shadowedRelIds);
    return relationshipGraphFromEdges(forward, inverse);
  }
}

/**
 * Plain-data column representation of `RelationshipEdges` (one half of a
 * `RelationshipGraph`). Holds CSR offsets, counts, and parallel edge arrays
 * with no closures.
 */
export interface RelationshipEdgesColumns {
  offsets: Map<number, number>;
  counts: Map<number, number>;
  edgeTargets: Uint32Array;
  edgeTypes: Uint16Array;
  edgeRelIds: Uint32Array;
  /** See `RelationshipEdges.shadowedEdgeIndex` et al. */
  shadowedEdgeIndex?: Uint32Array;
  shadowedGroupOffsets?: Uint32Array;
  shadowedRelIds?: Uint32Array;
}

/**
 * Plain-data representation of a complete bidirectional `RelationshipGraph`.
 * Used as the worker-transport payload — both halves are pure column data,
 * so the underlying buffers are transferable.
 */
export interface RelationshipGraphColumns {
  forward: RelationshipEdgesColumns;
  inverse: RelationshipEdgesColumns;
}

/**
 * Build CSR (Compressed Sparse Row) using counting sort.
 * O(n) instead of O(n log n) — crucial for 12M+ edges.
 *
 * Exported because the graph can be reconstructed from raw edge arrays
 * (e.g. when merging or rebuilding a graph) without going through the
 * `RelationshipGraphBuilder` mutation API. `shadowedRelIds` maps a
 * pre-scatter edge index (in `keys`/`values`/`types`/`relIds`) to the extra
 * `IfcRel*` ids collapsed into it; pass an empty `Map` when none.
 */
export function buildCSR(
  n: number,
  keys: number[] | Uint32Array,
  values: number[] | Uint32Array,
  types: number[] | Uint16Array,
  relIds: number[] | Uint32Array,
  shadowedRelIds: Map<number, number[]>,
): RelationshipEdges {
  if (n === 0) return emptyRelationshipEdges();

  // Step 1: count per key
  const countMap = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    countMap.set(k, (countMap.get(k) ?? 0) + 1);
  }

  // Step 2: prefix-sum offsets, sorted for deterministic order
  const offsets = new Map<number, number>();
  const counts = new Map<number, number>();
  const uniqueKeys = Array.from(countMap.keys()).sort((a, b) => a - b);
  let offset = 0;
  for (const k of uniqueKeys) {
    offsets.set(k, offset);
    counts.set(k, countMap.get(k)!);
    offset += countMap.get(k)!;
  }

  // Step 3: scatter edges into sorted positions
  const edgeTargets = new Uint32Array(n);
  const edgeTypes = new Uint16Array(n);
  const edgeRelIds = new Uint32Array(n);
  const writePos = new Map<number, number>();
  for (const [k, o] of offsets) writePos.set(k, o);

  // Collected in scatter (final-position) order below, then sorted — cheap
  // since this list is expected to stay tiny (rare duplicates) regardless
  // of how large `n` gets.
  const shadowedPairs: Array<[position: number, ids: number[]]> = [];

  for (let i = 0; i < n; i++) {
    const k = keys[i];
    const pos = writePos.get(k)!;
    edgeTargets[pos] = values[i];
    edgeTypes[pos] = types[i];
    edgeRelIds[pos] = relIds[i];
    const shadow = shadowedRelIds.get(i);
    if (shadow !== undefined) shadowedPairs.push([pos, shadow]);
    writePos.set(k, pos + 1);
  }

  const columns: RelationshipEdgesColumns = { offsets, counts, edgeTargets, edgeTypes, edgeRelIds };
  const shadowed = buildShadowedColumns(shadowedPairs);
  if (shadowed) Object.assign(columns, shadowed);

  return relationshipEdgesFromColumns(columns);
}

function emptyRelationshipEdges(): RelationshipEdges {
  return relationshipEdgesFromColumns({
    offsets: new Map(),
    counts: new Map(),
    edgeTargets: new Uint32Array(0),
    edgeTypes: new Uint16Array(0),
    edgeRelIds: new Uint32Array(0),
  });
}

/**
 * Rebuild the closure-bearing `RelationshipEdges` view (one direction of
 * the graph) from raw CSR columns. Used by both the in-process builder and
 * the parser-worker transport layer.
 */
export function relationshipEdgesFromColumns(columns: RelationshipEdgesColumns): RelationshipEdges {
  const { offsets, counts, edgeTargets, edgeTypes, edgeRelIds, shadowedEdgeIndex, shadowedGroupOffsets, shadowedRelIds } = columns;

  const edges: RelationshipEdges = {
    offsets,
    counts,
    edgeTargets,
    edgeTypes,
    edgeRelIds,

    getEdges(entityId: number, type?: RelationshipType): Edge[] {
      const o = offsets.get(entityId);
      if (o === undefined) return [];
      const c = counts.get(entityId)!;
      const out: Edge[] = [];
      for (let i = o; i < o + c; i++) {
        if (type === undefined || edgeTypes[i] === type) {
          const edge: Edge = { target: edgeTargets[i], type: edgeTypes[i], relationshipId: edgeRelIds[i] };
          if (shadowedEdgeIndex !== undefined && shadowedGroupOffsets !== undefined && shadowedRelIds !== undefined) {
            const g = binarySearchU32(shadowedEdgeIndex, i);
            if (g !== -1) {
              // A fresh array, not a view into the shared buffer.
              edge.shadowedRelationshipIds = Array.from(shadowedRelIds.subarray(shadowedGroupOffsets[g], shadowedGroupOffsets[g + 1]));
            }
          }
          out.push(edge);
        }
      }
      return out;
    },

    getTargets(entityId: number, type?: RelationshipType): number[] {
      return edges.getEdges(entityId, type).map(e => e.target);
    },

    hasAnyEdges(entityId: number): boolean {
      return offsets.has(entityId);
    },
  };
  if (shadowedEdgeIndex !== undefined) Object.assign(edges, { shadowedEdgeIndex, shadowedGroupOffsets, shadowedRelIds });
  return edges;
}

/**
 * Compose a complete `RelationshipGraph` from the two directional halves.
 * Splits cleanly so that the column extractor can pull edges without
 * touching the closures attached above.
 */
export function relationshipGraphFromEdges(
  forward: RelationshipEdges,
  inverse: RelationshipEdges,
): RelationshipGraph {
  return {
    forward,
    inverse,

    getRelated: (entityId, relType, direction) => {
      const e = direction === 'forward'
        ? forward.getEdges(entityId, relType)
        : inverse.getEdges(entityId, relType);
      return e.map((edge: Edge) => edge.target);
    },

    hasRelationship: (sourceId, targetId, relType) => {
      const e = forward.getEdges(sourceId, relType);
      return e.some((edge: Edge) => edge.target === targetId);
    },

    getRelationshipsBetween: (sourceId, targetId) => {
      return forward.getEdges(sourceId)
        .filter((edge: Edge) => edge.target === targetId)
        .map((edge: Edge): RelationshipInfo => {
          const info: RelationshipInfo = { relationshipId: edge.relationshipId, type: edge.type, typeName: RelationshipTypeToString(edge.type) };
          if (edge.shadowedRelationshipIds !== undefined) info.shadowedRelationshipIds = edge.shadowedRelationshipIds;
          return info;
        });
    },
  };
}

/**
 * Reconstruct a `RelationshipGraph` (closures + both halves) from the
 * column-only POJO produced by `relationshipGraphToColumns`.
 */
export function relationshipGraphFromColumns(columns: RelationshipGraphColumns): RelationshipGraph {
  return relationshipGraphFromEdges(
    relationshipEdgesFromColumns(columns.forward),
    relationshipEdgesFromColumns(columns.inverse),
  );
}

/**
 * Extract the column data (CSR offsets, counts, parallel edge arrays) from
 * a `RelationshipGraph`. The returned typed arrays alias the source — they
 * detach from the source when used in a `postMessage` transfer list.
 */
export function relationshipGraphToColumns(graph: RelationshipGraph): RelationshipGraphColumns {
  const toColumns = (edges: RelationshipEdges): RelationshipEdgesColumns => {
    const columns: RelationshipEdgesColumns = {
      offsets: edges.offsets,
      counts: edges.counts,
      edgeTargets: edges.edgeTargets,
      edgeTypes: edges.edgeTypes,
      edgeRelIds: edges.edgeRelIds,
    };
    if (edges.shadowedEdgeIndex !== undefined) {
      columns.shadowedEdgeIndex = edges.shadowedEdgeIndex;
      columns.shadowedGroupOffsets = edges.shadowedGroupOffsets;
      columns.shadowedRelIds = edges.shadowedRelIds;
    }
    return columns;
  };
  return {
    forward: toColumns(graph.forward),
    inverse: toColumns(graph.inverse),
  };
}

function RelationshipTypeToString(type: RelationshipType): string {
  const names: Record<RelationshipType, string> = {
    [RelationshipType.ContainsElements]: 'IfcRelContainedInSpatialStructure',
    [RelationshipType.Aggregates]: 'IfcRelAggregates',
    [RelationshipType.DefinesByProperties]: 'IfcRelDefinesByProperties',
    [RelationshipType.DefinesByType]: 'IfcRelDefinesByType',
    [RelationshipType.AssociatesMaterial]: 'IfcRelAssociatesMaterial',
    [RelationshipType.AssociatesClassification]: 'IfcRelAssociatesClassification',
    [RelationshipType.AssociatesDocument]: 'IfcRelAssociatesDocument',
    [RelationshipType.VoidsElement]: 'IfcRelVoidsElement',
    [RelationshipType.FillsElement]: 'IfcRelFillsElement',
    [RelationshipType.ConnectsPathElements]: 'IfcRelConnectsPathElements',
    [RelationshipType.ConnectsElements]: 'IfcRelConnectsElements',
    [RelationshipType.ConnectsPortToElement]: 'IfcRelConnectsPortToElement',
    [RelationshipType.ConnectsPorts]: 'IfcRelConnectsPorts',
    [RelationshipType.SpaceBoundary]: 'IfcRelSpaceBoundary',
    [RelationshipType.AssignsToGroup]: 'IfcRelAssignsToGroup',
    [RelationshipType.AssignsToProduct]: 'IfcRelAssignsToProduct',
    [RelationshipType.ReferencedInSpatialStructure]: 'IfcRelReferencedInSpatialStructure',
  };
  return names[type] || 'Unknown';
}
