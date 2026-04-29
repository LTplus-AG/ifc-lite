/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * RelationshipGraph serialization (CSR format)
 */

import type { RelationshipGraph, Edge, RelationshipInfo } from '@ifc-lite/data';
import { RelationshipType } from '@ifc-lite/data';
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
}

/**
 * Read RelationshipGraph from buffer
 */
export function readRelationships(reader: BufferReader): RelationshipGraph {
  const forward = readEdges(reader);
  const inverse = readEdges(reader);

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
        .map((e: Edge) => ({
          relationshipId: e.relationshipId,
          type: e.type,
          typeName: relationshipTypeToString(e.type),
        }));
    },
  };
}

function readEdges(reader: BufferReader): {
  offsets: Map<number, number>;
  counts: Map<number, number>;
  edgeTargets: Uint32Array;
  edgeTypes: Uint16Array;
  edgeRelIds: Uint32Array;
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

  return {
    offsets,
    counts,
    edgeTargets,
    edgeTypes,
    edgeRelIds,

    getEdges(entityId: number, type?: RelationshipType): Edge[] {
      const offset = offsets.get(entityId);
      if (offset === undefined) return [];

      const count = counts.get(entityId)!;
      const edges: Edge[] = [];

      for (let i = offset; i < offset + count; i++) {
        if (type === undefined || edgeTypes[i] === type) {
          edges.push({
            target: edgeTargets[i],
            type: edgeTypes[i],
            relationshipId: edgeRelIds[i],
          });
        }
      }

      return edges;
    },

    getTargets(entityId: number, type?: RelationshipType): number[] {
      return this.getEdges(entityId, type).map((e) => e.target);
    },

    hasAnyEdges(entityId: number): boolean {
      return offsets.has(entityId);
    },
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
    [RelationshipType.ConnectsStructuralMember]: 'IfcRelConnectsStructuralMember',
    [RelationshipType.ConnectsWithRealizingElements]: 'IfcRelConnectsWithRealizingElements',
    [RelationshipType.SpaceBoundary]: 'IfcRelSpaceBoundary',
    [RelationshipType.AssignsToGroup]: 'IfcRelAssignsToGroup',
    [RelationshipType.AssignsToProduct]: 'IfcRelAssignsToProduct',
    [RelationshipType.ReferencedInSpatialStructure]: 'ReferencedInSpatialStructure',
  };
  return names[type] || 'Unknown';
}
