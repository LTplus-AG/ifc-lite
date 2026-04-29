/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Relationship graph - bidirectional graph using CSR format
 * Enables fast traversal in both directions
 */

import { RelationshipType } from './types.js';

export interface Edge {
  target: number;
  type: RelationshipType;
  relationshipId: number;
}

export interface RelationshipEdges {
  offsets: Map<number, number>;
  counts: Map<number, number>;
  edgeTargets: Uint32Array;
  edgeTypes: Uint16Array;
  edgeRelIds: Uint32Array;

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
}

/**
 * Structure-of-Arrays relationship graph builder.
 * Uses parallel number arrays instead of object arrays to avoid millions of
 * small object allocations. Build phase uses counting sort (O(n)) instead
 * of comparison sort (O(n log n)) for massive speedup on large files.
 */
export class RelationshipGraphBuilder {
  private _sources: number[] = [];
  private _targets: number[] = [];
  private _types: number[] = [];
  private _relIds: number[] = [];

  addEdge(source: number, target: number, type: RelationshipType, relId: number): void {
    this._sources.push(source);
    this._targets.push(target);
    this._types.push(type);
    this._relIds.push(relId);
  }

  build(): RelationshipGraph {
    const n = this._sources.length;

    // Build forward CSR (sorted by source, value = target)
    const forward = this.buildCSR(n, this._sources, this._targets, this._types, this._relIds);
    // Build inverse CSR (sorted by target, value = source)
    const inverse = this.buildCSR(n, this._targets, this._sources, this._types, this._relIds);

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
            typeName: RelationshipTypeToString(e.type),
          }));
      },
    };
  }

  /**
   * Build CSR (Compressed Sparse Row) using counting sort.
   * O(n) instead of O(n log n) — crucial for 12M+ edges.
   */
  private buildCSR(
    n: number,
    keys: number[],       // sort key (source for forward, target for inverse)
    values: number[],     // stored value (target for forward, source for inverse)
    types: number[],
    relIds: number[],
  ): RelationshipEdges {
    if (n === 0) {
      return this.emptyEdges();
    }

    // Step 1: Count edges per key entity
    const countMap = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const k = keys[i];
      countMap.set(k, (countMap.get(k) ?? 0) + 1);
    }

    // Step 2: Compute offsets (prefix sums)
    const offsets = new Map<number, number>();
    const counts = new Map<number, number>();
    // Sort unique keys for deterministic CSR order
    const uniqueKeys = Array.from(countMap.keys()).sort((a, b) => a - b);
    let offset = 0;
    for (const k of uniqueKeys) {
      offsets.set(k, offset);
      counts.set(k, countMap.get(k)!);
      offset += countMap.get(k)!;
    }

    // Step 3: Place edges into sorted positions (counting sort scatter)
    const edgeTargets = new Uint32Array(n);
    const edgeTypes = new Uint16Array(n);
    const edgeRelIds = new Uint32Array(n);
    // Track current write position per key
    const writePos = new Map<number, number>();
    for (const [k, o] of offsets) {
      writePos.set(k, o);
    }

    for (let i = 0; i < n; i++) {
      const k = keys[i];
      const pos = writePos.get(k)!;
      edgeTargets[pos] = values[i];
      edgeTypes[pos] = types[i];
      edgeRelIds[pos] = relIds[i];
      writePos.set(k, pos + 1);
    }

    return {
      offsets,
      counts,
      edgeTargets,
      edgeTypes,
      edgeRelIds,

      getEdges(entityId: number, type?: RelationshipType): Edge[] {
        const o = offsets.get(entityId);
        if (o === undefined) return [];

        const c = counts.get(entityId)!;
        const edges: Edge[] = [];

        for (let i = o; i < o + c; i++) {
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
        return this.getEdges(entityId, type).map(e => e.target);
      },

      hasAnyEdges(entityId: number): boolean {
        return offsets.has(entityId);
      },
    };
  }

  private emptyEdges(): RelationshipEdges {
    return {
      offsets: new Map(),
      counts: new Map(),
      edgeTargets: new Uint32Array(0),
      edgeTypes: new Uint16Array(0),
      edgeRelIds: new Uint32Array(0),
      getEdges: () => [],
      getTargets: () => [],
      hasAnyEdges: () => false,
    };
  }
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
    [RelationshipType.ConnectsStructuralMember]: 'IfcRelConnectsStructuralMember',
    [RelationshipType.ConnectsWithRealizingElements]: 'IfcRelConnectsWithRealizingElements',
    [RelationshipType.SpaceBoundary]: 'IfcRelSpaceBoundary',
    [RelationshipType.AssignsToGroup]: 'IfcRelAssignsToGroup',
    [RelationshipType.AssignsToProduct]: 'IfcRelAssignsToProduct',
    [RelationshipType.ReferencedInSpatialStructure]: 'IfcRelReferencedInSpatialStructure',
  };
  return names[type] || 'Unknown';
}
