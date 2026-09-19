/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RelationshipType, relationshipTypeName, resolvedTypeName } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { normalizeIfcTypeName } from './ifc-schema.js';

/** One exact-class edge touching an entity (#4205). */
export interface ExactRelationshipEdge {
    relationshipId: number;
    relationshipType: string;
    direction: 'forward' | 'inverse';
    entity: { id: number; name?: string; type: string };
}

/** Structured relationship information for one entity. */
export interface EntityRelationships {
    voids: Array<{ id: number; name?: string; type: string }>;
    fills: Array<{ id: number; name?: string; type: string }>;
    groups: Array<{ id: number; name?: string; type: string }>;
    connections: Array<{ id: number; name?: string; type: string }>;
    relations: ExactRelationshipEdge[];
}

/**
 * Return every graph edge touching `entityId`, preserving the exact IfcRel*
 * STEP class. Compatibility aliases such as IfcRelNests occupy two enum
 * buckets, so the result is deduplicated by relationship record and target.
 */
export function extractExactRelationshipEdges(
    store: IfcDataStore,
    entityId: number,
): ExactRelationshipEdge[] {
    const result: ExactRelationshipEdge[] = [];
    const seen = new Set<string>();
    const entityInfo = (id: number): ExactRelationshipEdge['entity'] => {
        const ref = store.entityIndex.byId.get(id);
        const type = resolvedTypeName(store.entities, id)
            ?? (ref ? normalizeIfcTypeName(ref.type) : undefined)
            ?? 'Unknown';
        const name = store.entities.getName(id);
        return { id, name: name || undefined, type };
    };
    const append = (direction: 'forward' | 'inverse'): void => {
        const edges = direction === 'forward' ? store.relationships.forward : store.relationships.inverse;
        const touchingEdges = edges.getEdges(entityId);
        // A pre-data-model-v6 server uses relationshipId=0 for every row. Two
        // compatibility pairs occupy both a broad traversal bucket and an
        // exact bucket; reserve one broad zero for each exact zero so the
        // fallback keeps row cardinality without presenting aliases as records.
        const aliasZeros = new Map<string, number>();
        for (const edge of touchingEdges) {
            const primaryType = edge.type === RelationshipType.Nests
                ? RelationshipType.Aggregates
                : edge.type === RelationshipType.AssignsToGroupByFactor
                    ? RelationshipType.AssignsToGroup
                    : undefined;
            if (primaryType === undefined) continue;
            const zeroCount = [edge.relationshipId, ...(edge.shadowedRelationshipIds ?? [])]
                .filter((id) => id === 0).length;
            if (zeroCount > 0) aliasZeros.set(`${edge.target}:${primaryType}`, zeroCount);
        }
        for (const edge of touchingEdges) {
            for (const relationshipId of [edge.relationshipId, ...(edge.shadowedRelationshipIds ?? [])]) {
                if (relationshipId === 0) {
                    const aliasKey = `${edge.target}:${edge.type}`;
                    const aliasesRemaining = aliasZeros.get(aliasKey) ?? 0;
                    if (aliasesRemaining > 0) {
                        aliasZeros.set(aliasKey, aliasesRemaining - 1);
                        continue;
                    }
                } else {
                    const key = `${direction}:${relationshipId}:${edge.target}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                }
                result.push({
                    relationshipId,
                    relationshipType: resolvedTypeName(store.entities, relationshipId)
                        ?? relationshipTypeName(edge.type),
                    direction,
                    entity: entityInfo(edge.target),
                });
            }
        }
    };
    append('forward');
    append('inverse');
    return result;
}
