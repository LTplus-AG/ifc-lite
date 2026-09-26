/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';

/**
 * Resolve the OCCURRENCE-LEVEL material definition ids directly associated
 * with an entity (no type fallback): every IfcRelAssociatesMaterial that
 * targets it, deduped and ordered by the rel's express id — the same rule
 * that decides the single-entry `onDemandMaterialMap` winner, so index 0
 * always equals the map's entry. Falls back to the map when no relationship
 * graph is available (minimal/test stores).
 */
export function resolveOwnMaterialDefIds(store: IfcDataStore, entityId: number): number[] {
    if (store.relationships) {
        // Prefer getEdges (carries relationshipId for deterministic ordering);
        // facade graphs (server data model, test mocks) may implement only
        // getRelated, whose order is best-effort.
        if (typeof store.relationships.inverse?.getEdges === 'function') {
            const edges = store.relationships.inverse.getEdges(entityId, RelationshipType.AssociatesMaterial);
            if (edges.length > 0) {
                const sorted = [...edges].sort((a, b) => a.relationshipId - b.relationshipId);
                const out: number[] = [];
                for (const e of sorted) {
                    if (!out.includes(e.target)) out.push(e.target);
                }
                return out;
            }
        } else {
            const related = store.relationships.getRelated(entityId, RelationshipType.AssociatesMaterial, 'inverse');
            if (related.length > 0) return [...new Set(related)];
        }
    }
    // Map values are LISTS (all associations, file order) since #1773.
    const mapped = store.onDemandMaterialMap?.get(entityId);
    return mapped !== undefined ? [...mapped] : [];
}

/**
 * Resolve ALL material definition ids for an entity: every occurrence-level
 * IfcRelAssociatesMaterial (elements may legally carry more than one), or —
 * when the occurrence has none — the associations of its type
 * (IfcRelDefinesByType), matching {@link extractMaterialsOnDemand}'s
 * occurrence-overrides-type precedence. Ordered by rel express id, so
 * index 0 is the entity's deterministic "primary" material definition.
 */
export function resolveAllMaterialDefIds(store: IfcDataStore, entityId: number): number[] {
    return resolveMaterialOwnerAndDefIds(store, entityId).defIds;
}

export function resolveMaterialOwnerAndDefIds(store: IfcDataStore, entityId: number): { ownerId: number; defIds: number[] } {
    const own = resolveOwnMaterialDefIds(store, entityId);
    if (own.length > 0) return { ownerId: entityId, defIds: own };

    // Type fallback: first type with any association wins (mirrors the
    // single-def lookup's `break`).
    if (store.relationships) {
        const typeIds = store.relationships.getRelated(entityId, RelationshipType.DefinesByType, 'inverse');
        for (const typeId of typeIds) {
            const typeDefs = resolveOwnMaterialDefIds(store, typeId);
            if (typeDefs.length > 0) return { ownerId: typeId, defIds: typeDefs };
        }
    }
    return { ownerId: entityId, defIds: [] };
}
