/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Consumer-side helpers for `RelationshipGraph`'s deduped edges (#3760):
 * `RelationshipGraphBuilder.addEdge` folds a repeated `IfcRel*` naming the
 * same (source, target, type) triple into the surviving edge's
 * `shadowedRelationshipIds` rather than dropping it. Split out from
 * `relationship-graph.ts` (the CSR builder itself) since these operate on
 * the public `Edge`/`RelationshipEdges` surface, not the builder internals.
 */

import type { Edge, RelationshipEdges } from './relationship-graph.js';
import type { RelationshipType } from './types.js';

/**
 * True if the connection `edge` represents still exists once some
 * `IfcRel*` instances may have been deleted. A deduped edge remembers every
 * `IfcRel*` that named the same (source, target, type) triple — the edge
 * survives a delete as long as any one of `relationshipId` or
 * `shadowedRelationshipIds` is still live. Shared by the CLI and MCP
 * backends so their delete-then-query logic can't drift out of sync with
 * each other or with the graph's own dedupe (#3782 review).
 */
export function edgeSurvives(edge: Edge, isDeleted: (relationshipId: number) => boolean): boolean {
  if (!isDeleted(edge.relationshipId)) return true;
  return edge.shadowedRelationshipIds?.some((id) => !isDeleted(id)) ?? false;
}

/** One flattened relationship row; see `flattenRelationshipEdges`. */
export interface FlattenedRelationshipEdge {
  sourceId: number;
  targetId: number;
  type: RelationshipType;
  relationshipId: number;
}

/**
 * Flatten one CSR half (`RelationshipEdges`) to row-based form — one row
 * per `IfcRel*` STEP record that named this (source, target, type) triple,
 * not one row per deduped edge. Two `IfcRel*` instances can legally name
 * the same triple (#3760); `RelationshipGraphBuilder.addEdge` collapses
 * that to one edge and keeps the extra ids in `shadowedRelationshipIds`
 * rather than dropping them, so an exporter that walked the raw
 * `edgeRelIds` column alone (Parquet's `Relationships.parquet`, the DuckDB
 * `relationships` table) would silently drop that STEP record from its
 * output (#3782 review). Both use this shared helper instead of
 * hand-rolling the CSR walk so they cannot drift out of sync on it again.
 */
export function flattenRelationshipEdges(edges: RelationshipEdges): FlattenedRelationshipEdge[] {
  const out: FlattenedRelationshipEdge[] = [];
  for (const sourceId of edges.offsets.keys()) {
    for (const edge of edges.getEdges(sourceId)) {
      out.push({ sourceId, targetId: edge.target, type: edge.type, relationshipId: edge.relationshipId });
      if (edge.shadowedRelationshipIds) {
        for (const id of edge.shadowedRelationshipIds) {
          out.push({ sourceId, targetId: edge.target, type: edge.type, relationshipId: id });
        }
      }
    }
  }
  return out;
}

/** Output of `buildShadowedColumns`; see `RelationshipEdges.shadowedEdgeIndex`. */
export interface ShadowedColumns {
  shadowedEdgeIndex: Uint32Array;
  shadowedGroupOffsets: Uint32Array;
  shadowedRelIds: Uint32Array;
}

/**
 * Pack `(edgePosition, extraIds)` pairs collected during a CSR scatter into
 * the three sparse typed-array columns `RelationshipEdges` stores them as.
 * `buildCSR`'s only caller in-package; not re-exported from the package
 * index (see `binarySearchU32`, which the `@ifc-lite/cache` reader does
 * share). `pairs` need not be pre-sorted by position. Returns `undefined`
 * for an empty input so a caller can omit the columns entirely rather than
 * write out empty arrays — they're optional on `RelationshipEdges`.
 */
export function buildShadowedColumns(pairs: Array<[position: number, ids: number[]]>): ShadowedColumns | undefined {
  if (pairs.length === 0) return undefined;
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const shadowedEdgeIndex = new Uint32Array(sorted.length);
  const shadowedGroupOffsets = new Uint32Array(sorted.length + 1);
  let totalIds = 0;
  for (const [, ids] of sorted) totalIds += ids.length;
  const shadowedRelIds = new Uint32Array(totalIds);
  let cursor = 0;
  for (let g = 0; g < sorted.length; g++) {
    const [pos, ids] = sorted[g];
    shadowedEdgeIndex[g] = pos;
    shadowedGroupOffsets[g] = cursor;
    for (const id of ids) shadowedRelIds[cursor++] = id;
  }
  shadowedGroupOffsets[sorted.length] = cursor;
  return { shadowedEdgeIndex, shadowedGroupOffsets, shadowedRelIds };
}

/** Binary search for `target` in an ascending-sorted `Uint32Array`; -1 if absent. */
export function binarySearchU32(arr: Uint32Array, target: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = arr[mid];
    if (v === target) return mid;
    if (v < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
