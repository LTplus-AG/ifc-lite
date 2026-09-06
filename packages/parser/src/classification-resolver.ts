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
    /**
     * True when the relationship graph proves this entity/type carries a
     * classification association, but the classification's own attributes
     * (system, identification, name, path) could not be read because this
     * store has no source bytes — a server-parsed store (issue #3948).
     * Distinguishes "classified but unresolved" from "genuinely unclassified"
     * (an empty result array), which are otherwise byte-identical to every
     * caller. All other fields are left `undefined` on an unresolved entry.
     */
    unresolved?: boolean;
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
    if (!store.source?.length) {
        // Server-parsed / source-empty store: no source bytes to decode the
        // classification reference's own attributes. The relationship graph
        // above already proved this entity (or its type) IS classified — the
        // ids resolved into `classRefIds` are real
        // `IfcRelAssociatesClassification` targets.
        //
        // If the server also forwarded the resolved attributes (issue
        // #3955), prefer those — real system/identification/name data beats
        // a marker. Roll up the entity's own row plus its type's (mirroring
        // the classRefIds roll-up above) so a type-level classification is
        // not dropped.
        if (store.resolvedClassifications) {
            const resolved: ClassificationInfo[] = [...(store.resolvedClassifications.get(entityId) || [])];
            if (store.relationships) {
                const typeIds = store.relationships.getRelated(entityId, RelationshipType.DefinesByType, 'inverse');
                for (const typeId of typeIds) {
                    const typeResolved = store.resolvedClassifications.get(typeId);
                    if (typeResolved) resolved.push(...typeResolved);
                }
            }
            // Rows have no classification-reference id for an exact join.
            // A count mismatch means stale or incomplete payload data; do
            // not let those attributes certify an IDS constraint (#3959).
            if (resolved.length === classRefIds.length) return resolved;
        }
        // No forwarded resolved data. Turning an id into
        // system/identification/name/path needs raw STEP bytes
        // (`EntityExtractor`), which this store doesn't have. Previously
        // this silently returned `[]` here, making a classified entity
        // byte-identical to a genuinely unclassified one (issue #3948).
        // Surface one unresolved marker per resolved id instead, so callers
        // — the IDS bridge in particular — can tell "classified, but this
        // data source can't say more" from "none".
        return classRefIds.map((): ClassificationInfo => ({ unresolved: true }));
    }

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

/** Result of {@link extractClassificationSystemsOnDemand}. */
export interface ClassificationSystemNames {
    /** Distinct system names, sorted. Empty when the model genuinely has no
     *  `IfcClassification` entities — check `unresolved` before reading an
     *  empty array as "no systems". */
    names: string[];
    /**
     * True when the model DOES have `IfcClassification` entities (per the
     * byType index) but their `Name` could not be read because this store
     * has no source bytes — a server-parsed store (issue #3948), the same
     * condition `extractClassificationsOnDemand` signals per-entity via
     * `ClassificationInfo.unresolved`. When true, `names` is always `[]`
     * and must not be read as "the model has no classification systems".
     */
    unresolved: boolean;
}

/**
 * List the distinct classification system names present in a model —
 * CHEAP and EXACT when source bytes are available.
 *
 * Unlike extractClassificationsOnDemand (which resolves classifications for
 * ONE entity by walking its reference chain, and is only reachable through
 * elements that already have a classification association), this walks the
 * IfcClassification entities directly via the byType index. A model
 * typically has only a handful of IfcClassification entities (one per
 * system), regardless of how many elements are classified, so this is an
 * O(few) map lookup + loop — not a per-entity or per-element scan.
 *
 * A model can carry SEVERAL systems at once (e.g. Uniclass, OmniClass, and
 * a national system) — this returns all of them, sorted alphabetically.
 */
export function extractClassificationSystemsOnDemand(store: IfcDataStore): ClassificationSystemNames {
    const ids = store.entityIndex.byType.get('IFCCLASSIFICATION');
    if (!ids || ids.length === 0) return { names: [], unresolved: false };
    if (!store.source?.length) {
        // The model has classification systems (confirmed by the byType
        // index), but reading their Name needs raw STEP bytes this
        // server-parsed store doesn't carry. `[]` alone would be
        // indistinguishable from "no systems" (issue #3948).
        return { names: [], unresolved: true };
    }

    const extractor = new EntityExtractor(store.source);
    const names = new Set<string>();

    for (const id of ids) {
        const ref = store.entityIndex.byId.get(id);
        if (!ref) continue;

        const entity = extractor.extractEntity(ref);
        if (!entity) continue;

        // IfcClassification: [Source, Edition, EditionDate, Name, ...]
        const name = entity.attributes?.[3];
        if (typeof name === 'string' && name.length > 0) names.add(name);
    }

    return { names: Array.from(names).sort(), unresolved: false };
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
