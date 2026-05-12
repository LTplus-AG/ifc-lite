/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification extraction — resolves IfcClassificationReference chains
 * and IfcClassification systems for entity classification lookups.
 */

import { EntityExtractor } from './entity-extractor.js';
import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';

export interface ClassificationInfo {
    system?: string;
    identification?: string;
    name?: string;
    location?: string;
    description?: string;
    path?: string[];
}

/**
 * Extract classifications for a single entity ON-DEMAND.
 * Uses the onDemandClassificationMap built during parsing.
 * Falls back to relationship graph when on-demand map is not available (e.g., server-loaded models).
 * Also checks type-level associations via IfcRelDefinesByType.
 * Returns an array of classification references with system info.
 */
export function extractClassificationsOnDemand(
    store: IfcDataStore,
    entityId: number
): ClassificationInfo[] {
    let classRefIds: number[] | undefined;

    if (store.onDemandClassificationMap) {
        classRefIds = store.onDemandClassificationMap.get(entityId);
    } else if (store.relationships) {
        // Fallback: use relationship graph (server-loaded models)
        const related = store.relationships.getRelated(entityId, RelationshipType.AssociatesClassification, 'inverse');
        if (related.length > 0) classRefIds = related;
    }

    // Also check type-level classifications via IfcRelDefinesByType
    if (store.relationships) {
        const typeIds = store.relationships.getRelated(entityId, RelationshipType.DefinesByType, 'inverse');
        for (const typeId of typeIds) {
            let typeClassRefs: number[] | undefined;
            if (store.onDemandClassificationMap) {
                typeClassRefs = store.onDemandClassificationMap.get(typeId);
            } else {
                const related = store.relationships.getRelated(typeId, RelationshipType.AssociatesClassification, 'inverse');
                if (related.length > 0) typeClassRefs = related;
            }
            if (typeClassRefs && typeClassRefs.length > 0) {
                classRefIds = classRefIds ? [...classRefIds, ...typeClassRefs] : [...typeClassRefs];
            }
        }
    }

    if (!classRefIds || classRefIds.length === 0) return [];
    if (!store.source?.length) return [];

    const extractor = new EntityExtractor(store.source);
    const results: ClassificationInfo[] = [];

    for (const classRefId of classRefIds) {
        const ref = store.entityIndex.byId.get(classRefId);
        if (!ref) continue;

        const entity = extractor.extractEntity(ref);
        if (!entity) continue;

        const typeUpper = entity.type.toUpperCase();
        const attrs = entity.attributes || [];

        if (typeUpper === 'IFCCLASSIFICATIONREFERENCE') {
            // IfcClassificationReference: [Location, Identification, Name, ReferencedSource, Description, Sort]
            const info: ClassificationInfo = {
                location: typeof attrs[0] === 'string' ? attrs[0] : undefined,
                identification: typeof attrs[1] === 'string' ? attrs[1] : undefined,
                name: typeof attrs[2] === 'string' ? attrs[2] : undefined,
                description: typeof attrs[4] === 'string' ? attrs[4] : undefined,
            };

            // Walk up to find the classification system name
            const referencedSourceId = typeof attrs[3] === 'number' ? attrs[3] : undefined;
            if (referencedSourceId) {
                const path = walkClassificationChain(store, extractor, referencedSourceId);
                info.system = path.systemName;
                info.path = path.codes;
            }

            results.push(info);
        } else if (typeUpper === 'IFCCLASSIFICATION') {
            // IfcClassification: [Source, Edition, EditionDate, Name, Description, Location, ReferenceTokens]
            results.push({
                system: typeof attrs[3] === 'string' ? attrs[3] : undefined,
                name: typeof attrs[3] === 'string' ? attrs[3] : undefined,
                description: typeof attrs[4] === 'string' ? attrs[4] : undefined,
                location: typeof attrs[5] === 'string' ? attrs[5] : undefined,
            });
        }
    }

    return results;
}

/**
 * Walk up the IfcClassificationReference chain to find the root IfcClassification system.
 */
function walkClassificationChain(
    store: IfcDataStore,
    extractor: EntityExtractor,
    startId: number
): { systemName?: string; codes: string[] } {
    const codes: string[] = [];
    let currentId: number | undefined = startId;
    const visited = new Set<number>();

    while (currentId !== undefined && !visited.has(currentId)) {
        visited.add(currentId);

        const ref = store.entityIndex.byId.get(currentId);
        if (!ref) break;

        const entity = extractor.extractEntity(ref);
        if (!entity) break;

        const typeUpper = entity.type.toUpperCase();
        const attrs = entity.attributes || [];

        if (typeUpper === 'IFCCLASSIFICATION') {
            // Root: IfcClassification [Source, Edition, EditionDate, Name, ...]
            const systemName = typeof attrs[3] === 'string' ? attrs[3] : undefined;
            return { systemName, codes };
        }

        if (typeUpper === 'IFCCLASSIFICATIONREFERENCE') {
            // IfcClassificationReference [Location, Identification, Name, ReferencedSource, ...]
            const code = typeof attrs[1] === 'string' ? attrs[1] :
                         typeof attrs[2] === 'string' ? attrs[2] : undefined;
            if (code) codes.unshift(code);

            currentId = typeof attrs[3] === 'number' ? attrs[3] : undefined;
        } else {
            break;
        }
    }

    return { codes };
}
