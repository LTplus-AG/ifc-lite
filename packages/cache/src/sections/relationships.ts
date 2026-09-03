/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * RelationshipGraph serialization (CSR format)
 */

import type { RelationshipGraph, Edge, RelationshipInfo } from '@ifc-lite/data';
import { RelationshipType, binarySearchU32 } from '@ifc-lite/data';
import { BufferWriter, BufferReader } from '../utils/buffer-utils.js';

/**
 * Write RelationshipGraph to buffer
 * Format (for each direction - forward and inverse):
 *   - nodeCount: uint32
 *   - nodes: [entityId:uint32, offset:uint32, count:uint32][]
 *   - edgeCount: uint32
 *   - edgeTargets: Uint32Array[edgeCount]
 *   - edgeTypes: Uint16Array[edgeCount]
 *   - edgeRelIds: Uint32Array[edgeCount]
 *   - shadowedGroupCount: uint32 (v18+, #3782: edges collapsed from more
 *     than one IfcRel* instance — see RelationshipGraphBuilder.addEdge)
 *   - shadowedEdgeIndex: Uint32Array[shadowedGroupCount]
 *   - shadowedGroupOffsets: Uint32Array[shadowedGroupCount + 1]
 *   - shadowedIdCount: uint32
 *   - shadowedRelIds: Uint32Array[shadowedIdCount]
 *
 * A v17 reader stops after edgeRelIds — the trailing shadow section is new
 * bytes it never asks for, and the section table's own size field bounds
 * how far a stray future read could reach. A v18+ reader given a v17
 * section (should one ever reach it — the cache LOOKUP key embeds
 * FORMAT_VERSION, so normal load paths never do) must not attempt the
 * shadow read at all; see the `version` parameter on `readRelationships`.
 */
export function writeRelationships(writer: BufferWriter, graph: RelationshipGraph): void {
  // Write forward edges
  writeEdges(writer, graph.forward);

  // Write inverse edges
  writeEdges(writer, graph.inverse);
}

function writeEdges(
  writer: BufferWriter,
  edges: {
    offsets: Map<number, number>;
    counts: Map<number, number>;
    edgeTargets: Uint32Array;
    edgeTypes: Uint16Array;
    edgeRelIds: Uint32Array;
    shadowedEdgeIndex?: Uint32Array;
    shadowedGroupOffsets?: Uint32Array;
    shadowedRelIds?: Uint32Array;
  }
): void {
  // Write node mappings
  const nodeCount = edges.offsets.size;
  writer.writeUint32(nodeCount);

  for (const [entityId, offset] of edges.offsets) {
    const count = edges.counts.get(entityId) ?? 0;
    writer.writeUint32(entityId);
    writer.writeUint32(offset);
    writer.writeUint32(count);
  }

  // Write edge arrays
  const edgeCount = edges.edgeTargets.length;
  writer.writeUint32(edgeCount);

  writer.writeTypedArray(edges.edgeTargets);
  writer.writeTypedArray(edges.edgeTypes);
  writer.writeTypedArray(edges.edgeRelIds);

  // Shadowed rel ids: sparse (absent whenever no edge in this half collapsed
  // more than one IfcRel* instance), so this costs 4 bytes on the
  // overwhelming majority of graphs.
  const shadowedEdgeIndex = edges.shadowedEdgeIndex ?? new Uint32Array(0);
  const shadowedGroupOffsets = edges.shadowedGroupOffsets ?? new Uint32Array([0]);
  const shadowedRelIds = edges.shadowedRelIds ?? new Uint32Array(0);
  writer.writeUint32(shadowedEdgeIndex.length);
  writer.writeTypedArray(shadowedEdgeIndex);
  writer.writeTypedArray(shadowedGroupOffsets);
  writer.writeUint32(shadowedRelIds.length);
  writer.writeTypedArray(shadowedRelIds);
}

/**
 * Read RelationshipGraph from buffer. `version` is the cache header's
 * FORMAT_VERSION — v17 sections have no shadow-id trailer (see
 * `writeEdges`'s doc comment); pass the header's actual version so a v17
 * section isn't misread as a v18+ one.
 *
 * Required, not defaulted to `FORMAT_VERSION`: a forgotten argument would
 * silently read every buffer as the CURRENT version, the unsafe direction —
 * a real v17 blob would be misread as v18 and hit `validateShadowedColumns`
 * on bytes that were never written as a trailer at all (#3782 round 3
 * review). `reader.ts`'s only call site already threads `header.version`
 * through.
 */
export function readRelationships(reader: BufferReader, version: number): RelationshipGraph {
  const forward = readEdges(reader, version);
  const inverse = readEdges(reader, version);

  return {
    forward,
    inverse,

    getRelated: (entityId, relType, direction) => {
      const edges = direction === 'forward'
        ? forward.getEdges(entityId, relType)
        : inverse.getEdges(entityId, relType);
      return edges.map((e: Edge) => e.target);
    },

    hasRelationship: (sourceId, targetId, relType) => {
      const edges = forward.getEdges(sourceId, relType);
      return edges.some((e: Edge) => e.target === targetId);
    },

    getRelationshipsBetween: (sourceId, targetId) => {
      const edges = forward.getEdges(sourceId);
      return edges
        .filter((e: Edge) => e.target === targetId)
        .map((e: Edge): RelationshipInfo => {
          const info: RelationshipInfo = {
            relationshipId: e.relationshipId,
            type: e.type,
            typeName: relationshipTypeToString(e.type),
          };
          if (e.shadowedRelationshipIds !== undefined) {
            info.shadowedRelationshipIds = e.shadowedRelationshipIds;
          }
          return info;
        });
    },
  };
}

/**
 * Fail fast on a corrupt shadowed-rel-ids trailer (v18+, #3782), the same
 * way the (offset, count) guard above does for the base edge arrays:
 * `readUint32Array` only bounds-checks against the buffer's remaining
 * bytes, it says nothing about whether the VALUES it read are internally
 * consistent. Without this, `getEdges`'s `binarySearchU32` +
 * `shadowedRelIds.subarray(...)` silently attaches the wrong ids to the
 * wrong edge, clamps or overruns the slice, or (an out-of-range
 * `shadowedEdgeIndex` entry) drops a group's shadowed ids entirely — every
 * one of those is wrong data returned without an error, not a crash.
 *
 * Checks, in the order a corrupt encoder is most likely to break them:
 *  - `shadowedGroupOffsets.length === shadowedEdgeIndex.length + 1`
 *  - `shadowedGroupOffsets[0] === 0`
 *  - `shadowedGroupOffsets` strictly increasing (equal neighbours would be
 *    an empty group, which `buildShadowedColumns` never emits — see its
 *    "present implies non-empty" invariant)
 *  - `shadowedGroupOffsets[last] === shadowedRelIds.length`
 *  - `shadowedEdgeIndex` strictly ascending and every entry `< edgeCount`
 */
function validateShadowedColumns(
  shadowedEdgeIndex: Uint32Array,
  shadowedGroupOffsets: Uint32Array,
  shadowedRelIds: Uint32Array,
  edgeCount: number,
): void {
  const groupCount = shadowedEdgeIndex.length;
  if (shadowedGroupOffsets.length !== groupCount + 1) {
    throw new Error(
      `Corrupt cache RelationshipGraph: shadowedGroupOffsets has ${shadowedGroupOffsets.length} ` +
        `entries, expected ${groupCount + 1} for ${groupCount} shadowed group(s)`,
    );
  }
  if (shadowedGroupOffsets[0] !== 0) {
    throw new Error(`Corrupt cache RelationshipGraph: shadowedGroupOffsets[0] must be 0, got ${shadowedGroupOffsets[0]}`);
  }
  if (shadowedGroupOffsets[groupCount] !== shadowedRelIds.length) {
    throw new Error(
      `Corrupt cache RelationshipGraph: shadowedGroupOffsets[${groupCount}] ` +
        `(${shadowedGroupOffsets[groupCount]}) does not match shadowedRelIds length ${shadowedRelIds.length}`,
    );
  }
  let prevEdgeIndex = -1;
  for (let g = 0; g < groupCount; g++) {
    const edgeIndex = shadowedEdgeIndex[g];
    if (edgeIndex <= prevEdgeIndex) {
      throw new Error(
        `Corrupt cache RelationshipGraph: shadowedEdgeIndex is not strictly ascending ` +
          `at group ${g} (${edgeIndex} <= ${prevEdgeIndex})`,
      );
    }
    if (edgeIndex >= edgeCount) {
      throw new Error(
        `Corrupt cache RelationshipGraph: shadowedEdgeIndex[${g}] = ${edgeIndex} is out of range for edgeCount ${edgeCount}`,
      );
    }
    prevEdgeIndex = edgeIndex;
    if (shadowedGroupOffsets[g + 1] <= shadowedGroupOffsets[g]) {
      throw new Error(
        `Corrupt cache RelationshipGraph: shadowed group ${g} is empty ` +
          `[${shadowedGroupOffsets[g]}, ${shadowedGroupOffsets[g + 1]})`,
      );
    }
  }
}

function readEdges(reader: BufferReader, version: number): {
  offsets: Map<number, number>;
  counts: Map<number, number>;
  edgeTargets: Uint32Array;
  edgeTypes: Uint16Array;
  edgeRelIds: Uint32Array;
  shadowedEdgeIndex?: Uint32Array;
  shadowedGroupOffsets?: Uint32Array;
  shadowedRelIds?: Uint32Array;
  getEdges(entityId: number, type?: RelationshipType): Edge[];
  getTargets(entityId: number, type?: RelationshipType): number[];
  hasAnyEdges(entityId: number): boolean;
} {
  const nodeCount = reader.readUint32();
  const offsets = new Map<number, number>();
  const counts = new Map<number, number>();

  for (let i = 0; i < nodeCount; i++) {
    const entityId = reader.readUint32();
    const offset = reader.readUint32();
    const count = reader.readUint32();
    offsets.set(entityId, offset);
    counts.set(entityId, count);
  }

  const edgeCount = reader.readUint32();
  const edgeTargets = reader.readUint32Array(edgeCount);
  const edgeTypes = reader.readUint16Array(edgeCount);
  const edgeRelIds = reader.readUint32Array(edgeCount);

  // Fail fast on a corrupt cache: each node's (offset, count) pair is an
  // independent field from `edgeCount` — `BufferReader`'s own bounds checks
  // (see its `ensureAvailable` doc comment) only guarantee the edge arrays
  // themselves are `edgeCount` long, they say nothing about whether a given
  // node's range stays inside that. Without this check, `getEdges` below
  // reads `edgeTargets[i]` for `i` past the array's end — a plain JS typed-
  // array index-out-of-bounds, which silently yields `undefined` rather than
  // throwing — and returns edges with an `undefined` target/type/
  // relationshipId mixed in with the real ones instead of failing loudly.
  // Mirrors the same-shaped guards already in `strings.ts` (offset
  // monotonicity) and `entity-index.ts` (typeIndex range).
  for (const [entityId, offset] of offsets) {
    const count = counts.get(entityId) ?? 0;
    if (offset + count > edgeCount) {
      throw new Error(
        `Corrupt cache RelationshipGraph: entity ${entityId}'s edge range ` +
          `[${offset}, ${offset + count}) exceeds edge array length ${edgeCount}`,
      );
    }
  }

  let shadowedEdgeIndex: Uint32Array | undefined;
  let shadowedGroupOffsets: Uint32Array | undefined;
  let shadowedRelIds: Uint32Array | undefined;
  if (version >= 18) {
    const shadowedGroupCount = reader.readUint32();
    shadowedEdgeIndex = reader.readUint32Array(shadowedGroupCount);
    shadowedGroupOffsets = reader.readUint32Array(shadowedGroupCount + 1);
    const shadowedIdCount = reader.readUint32();
    shadowedRelIds = reader.readUint32Array(shadowedIdCount);
    validateShadowedColumns(shadowedEdgeIndex, shadowedGroupOffsets, shadowedRelIds, edgeCount);
  }

  const edges = {
    offsets,
    counts,
    edgeTargets,
    edgeTypes,
    edgeRelIds,
    shadowedEdgeIndex,
    shadowedGroupOffsets,
    shadowedRelIds,

    getEdges(entityId: number, type?: RelationshipType): Edge[] {
      const offset = offsets.get(entityId);
      if (offset === undefined) return [];

      const count = counts.get(entityId)!;
      const result: Edge[] = [];

      for (let i = offset; i < offset + count; i++) {
        if (type === undefined || edgeTypes[i] === type) {
          const edge: Edge = {
            target: edgeTargets[i],
            type: edgeTypes[i],
            relationshipId: edgeRelIds[i],
          };
          if (shadowedEdgeIndex && shadowedGroupOffsets && shadowedRelIds) {
            const g = binarySearchU32(shadowedEdgeIndex, i);
            if (g !== -1) {
              edge.shadowedRelationshipIds = Array.from(
                shadowedRelIds.subarray(shadowedGroupOffsets[g], shadowedGroupOffsets[g + 1]),
              );
            }
          }
          result.push(edge);
        }
      }

      return result;
    },

    getTargets(entityId: number, type?: RelationshipType): number[] {
      return this.getEdges(entityId, type).map((e) => e.target);
    },

    hasAnyEdges(entityId: number): boolean {
      return offsets.has(entityId);
    },
  };

  // `shadowedEdgeIndex`/etc. are `undefined` (not present) on a pre-#3782
  // cache read (version < 18) — matches `RelationshipEdges`'s optional
  // fields exactly, so `edges` above satisfies the interface either way
  // without a cast.
  return edges as typeof edges & {
    shadowedEdgeIndex?: Uint32Array;
    shadowedGroupOffsets?: Uint32Array;
    shadowedRelIds?: Uint32Array;
  };
}

function relationshipTypeToString(type: RelationshipType): string {
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
    [RelationshipType.ReferencedInSpatialStructure]: 'ReferencedInSpatialStructure',
  };
  return names[type] || 'Unknown';
}
