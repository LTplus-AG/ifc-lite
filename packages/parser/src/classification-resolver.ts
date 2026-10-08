/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Classification extraction — resolves IfcClassificationReference chains
 * and IfcClassification systems for entity classification lookups.
 */

import { getReference } from './attribute-helpers.js';
import { EntityExtractor } from './entity-extractor.js';
import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { classificationEdges, classificationRecord, classificationSystemIds, type ClassificationReadView } from './classification-overlay.js';

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
     * With live edits on a source-empty store these markers retain immutable
     * source evidence; edited source membership needs the original bytes and
     * must not be counted as a known current population.
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
    entityId: number,
    view?: ClassificationReadView,
): ClassificationInfo[] {
    if (view?.isDeleted(entityId)) return [];
    const overlayEdges = view ? classificationEdges(store, view) : null;
    const effectiveEdges = store.source?.length ? overlayEdges : null;
    const baseId = view?.resolveBaseEntityId?.(entityId) ?? entityId;
    const subjects = baseId === entityId ? [entityId] : [entityId, baseId];
    let classRefIds: number[] | undefined;

    if (effectiveEdges) {
        classRefIds = subjects.flatMap(id => effectiveEdges.references.get(id) ?? []);
    } else if (store.onDemandClassificationMap) {
        classRefIds = subjects.flatMap(id => store.onDemandClassificationMap?.get(id) ?? []);
    } else if (store.relationships) {
        // Fallback: use relationship graph (server-loaded models)
        const related = store.relationships.getRelated(entityId, RelationshipType.AssociatesClassification, 'inverse');
        if (related.length > 0) classRefIds = related;
    }

    // Also check type-level classifications via IfcRelDefinesByType
    if (effectiveEdges || store.relationships) {
        const typeIds = effectiveEdges ? subjects.flatMap(id => effectiveEdges.types.get(id) ?? []) : store.relationships?.getRelated(baseId, RelationshipType.DefinesByType, 'inverse') ?? [];
        for (const typeId of typeIds) {
            let typeClassRefs: number[] | undefined;
            if (effectiveEdges) {
                typeClassRefs = effectiveEdges.references.get(typeId);
            } else if (store.onDemandClassificationMap) {
                typeClassRefs = store.onDemandClassificationMap.get(typeId);
            } else {
                const related = store.relationships?.getRelated(typeId, RelationshipType.AssociatesClassification, 'inverse') ?? [];
                if (related.length > 0) typeClassRefs = related;
            }
            if (typeClassRefs && typeClassRefs.length > 0) {
                classRefIds = classRefIds ? [...classRefIds, ...typeClassRefs] : [...typeClassRefs];
            }
        }
    }

    const authoredRefIds = !store.source?.length && overlayEdges
        ? subjects.flatMap(id => [...(overlayEdges.references.get(id) ?? []),
            ...(overlayEdges.types.get(id) ?? []).flatMap(typeId => overlayEdges.references.get(typeId) ?? [])])
        : [];
    const authored = authoredRefIds.flatMap(id => {
        const info = classificationInfoForRef(store, id, view);
        return info ? [info] : [];
    });
    if (!classRefIds || classRefIds.length === 0) return authored;
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
            // The server resolves these rows from the same immutable input
            // as its graph. Repeated relationships emit repeated rows while
            // the graph deduplicates edges, so their counts need not match.
            if (resolved.length > 0) return [...(overlayEdges?.unresolvedSource ? resolved.map((): ClassificationInfo => ({ unresolved: true })) : resolved), ...authored];
        }
        // No forwarded resolved data. Turning an id into
        // system/identification/name/path needs raw STEP bytes
        // (`EntityExtractor`), which this store doesn't have. Previously
        // this silently returned `[]` here, making a classified entity
        // byte-identical to a genuinely unclassified one (issue #3948).
        // Surface one unresolved marker per resolved id instead, so callers
        // — the IDS bridge in particular — can tell "classified, but this
        // data source can't say more" from "none".
        return [...classRefIds.map((): ClassificationInfo => ({ unresolved: true })), ...authored];
    }

    return classRefIds.flatMap(id => {
        const info = classificationInfoForRef(store, id, view);
        return info ? [info] : [];
    });
}

/** One source/authored reference, through the same effective record and bounded chain reader. */
function classificationInfoForRef(store: IfcDataStore, classRefId: number, view?: ClassificationReadView): ClassificationInfo | null {
    const entity = classificationRecord(store, classRefId, view);
    if (!entity) return null;
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
        const referencedSourceId = getReference(attrs[3]);
        if (referencedSourceId) {
            const path = walkClassificationChain(store, new EntityExtractor(store.source), referencedSourceId, view);
            info.system = path.systemName;
            info.path = path.codes;
            // A dangling link, an unreadable entity, or an unexpected
            // type broke the walk before it reached an IfcClassification
            // root (#5290) — distinct from a `ReferencedSource` that was
            // never there to begin with, which `path.chainUnresolved`
            // leaves `false` (see the function doc). `info.system` stays
            // `undefined` either way, so without this flag
            // `resolveClassifications` cannot tell "chain could not be
            // resolved" from "chain resolved to no system", and flattens
            // both to a confident empty system (`c.system || ''`) — a
            // definite mismatch, not the unresolved-chain result this
            // marks it for.
            if (path.chainUnresolved) info.unresolved = true;
        }

        return info;
    } else if (typeUpper === 'IFCCLASSIFICATION') {
        // IfcClassification: [Source, Edition, EditionDate, Name, Description, Location, ReferenceTokens]
        return {
            system: typeof attrs[3] === 'string' ? attrs[3] : undefined,
            name: typeof attrs[3] === 'string' ? attrs[3] : undefined,
            description: typeof attrs[4] === 'string' ? attrs[4] : undefined,
            location: typeof attrs[5] === 'string' ? attrs[5] : undefined,
        };
    }
    return null;
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
     * `ClassificationInfo.unresolved`. An effective view may still supply
     * complete authored names alongside unreadable source systems. When
     * true, `names` is incomplete and cannot establish a system's absence.
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
export function extractClassificationSystemsOnDemand(store: IfcDataStore, view?: ClassificationReadView): ClassificationSystemNames {
    // @raw-entity-enumeration-ok this parser API enumerates systems in the parsed source; live viewer sessions use effectiveClassificationSystems
    const ids = view ? classificationSystemIds(store, view) : store.entityIndex.byType.get('IFCCLASSIFICATION');
    if (!ids || ids.length === 0) return { names: [], unresolved: false };
    if (!store.source?.length && !view) {
        // The model has classification systems (confirmed by the byType
        // index), but reading their Name needs raw STEP bytes this
        // server-parsed store doesn't carry. `[]` alone would be
        // indistinguishable from "no systems" (issue #3948).
        return { names: [], unresolved: true };
    }

    const extractor = new EntityExtractor(store.source);
    const names = new Set<string>();
    let unresolved = false;

    for (const id of ids) {
        // @raw-entity-enumeration-ok each source classification id needs its STEP byte span to decode Name
        const ref = store.entityIndex.byId.get(id);
        if (!ref && !view?.getNewEntity(id)) continue;

        const entity = view ? classificationRecord(store, id, view) : extractor.extractEntity(ref!);
        if (!entity) { unresolved = true; continue; }

        // IfcClassification: [Source, Edition, EditionDate, Name, ...]
        const name = entity.attributes?.[3];
        if (typeof name === 'string' && name.length > 0) names.add(name);
        else if (!store.source?.length && name === undefined) unresolved = true;
    }

    return { names: Array.from(names).sort(), unresolved };
}

/**
 * Walk up the IfcClassificationReference chain to find the root IfcClassification system.
 *
 * `chainUnresolved` (#5290) is `true` when the walk stopped WITHOUT ever
 * reaching an `IfcClassification` root and WITHOUT the chain legitimately
 * ending on its own terms — a dangling `ReferencedSource` (the id does not
 * resolve in `entityIndex`), an entity whose bytes cannot be extracted, an
 * entity of a type that is neither `IfcClassification` nor
 * `IfcClassificationReference`, or a cycle back to an id already visited.
 * Every one of those means "this data cannot say whether a system exists",
 * not "there is no system" — the caller (`extractClassificationsOnDemand`)
 * needs to tell that apart from a chain that simply ran out of links
 * (`ReferencedSource` omitted, `$`, which IS schema-legal and leaves
 * `chainUnresolved: false`): the two are otherwise byte-identical, both
 * returning `systemName: undefined`.
 */
function walkClassificationChain(
    store: IfcDataStore,
    extractor: EntityExtractor,
    startId: number,
    view?: ClassificationReadView,
): { systemName?: string; codes: string[]; chainUnresolved: boolean } {
    const codes: string[] = [];
    let currentId: number | undefined = startId;
    const visited = new Set<number>();

    while (currentId !== undefined) {
        if (visited.has(currentId)) {
            return { codes, chainUnresolved: true };
        }
        visited.add(currentId);

        // @raw-entity-enumeration-ok chain cursor follows source ReferencedSource links and decodes each STEP record
        const ref = store.entityIndex.byId.get(currentId);
        if (!ref && !view?.getNewEntity(currentId)) return { codes, chainUnresolved: true };

        const entity = view ? classificationRecord(store, currentId, view) : extractor.extractEntity(ref!);
        if (!entity) return { codes, chainUnresolved: true };

        const typeUpper = entity.type.toUpperCase();
        const attrs = entity.attributes || [];

        if (typeUpper === 'IFCCLASSIFICATION') {
            // Root: IfcClassification [Source, Edition, EditionDate, Name, ...]
            const systemName = typeof attrs[3] === 'string' ? attrs[3] : undefined;
            return { systemName, codes, chainUnresolved: !store.source?.length && systemName === undefined && !view?.getNewEntity(currentId) };
        }

        if (typeUpper === 'IFCCLASSIFICATIONREFERENCE') {
            // IfcClassificationReference [Location, Identification, Name, ReferencedSource, ...]
            const code = typeof attrs[1] === 'string' ? attrs[1] :
                         typeof attrs[2] === 'string' ? attrs[2] : undefined;
            if (code) codes.unshift(code);

            currentId = getReference(attrs[3]);
        } else {
            return { codes, chainUnresolved: true };
        }
    }

    // `currentId` became `undefined`: `ReferencedSource` was omitted (`$`).
    // Schema-legal, not malformed — an `IfcClassificationReference` is
    // allowed to not name a system.
    return { codes, chainUnresolved: false };
}
