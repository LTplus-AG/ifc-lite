/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EntityExtractor } from './entity-extractor.js';
import { extractCurrentTypeQuantities } from './current-type-quantities.js';
import type { MetadataReadView } from './effective-metadata-record.js';
import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { readQuantitySet, type CollectedQuantity } from './quantity-collect.js';
import { appendSetsFromSecondSource, setIdentityKey } from './property-set-merge.js';
import type { TypeQuantityInfo } from './on-demand-extractors.js';
import { getInheritanceChain } from './ifc-schema.js';

/**
 * Extract quantity sets (IfcElementQuantity) from a list of set IDs using the
 * entity index. The quantity counterpart of {@link extractPsetsFromIds}: it
 * skips anything that is not an IFCELEMENTQUANTITY (e.g. property sets that
 * share the HasPropertySets list on a type).
 */
export function extractQsetsFromIds(
    store: IfcDataStore,
    extractor: EntityExtractor,
    qsetIds: number[]
): Array<{ name: string; globalId?: string; quantities: CollectedQuantity[] }> {
    const result: Array<{ name: string; globalId?: string; quantities: CollectedQuantity[] }> = [];

    for (const qsetId of qsetIds) {
        // @raw-entity-enumeration-ok one requested quantity-set id is decoded from its source STEP span
        const qsetRef = store.entityIndex.byId.get(qsetId);
        if (!qsetRef) continue;

        // Only extract IFCELEMENTQUANTITY entities (skip property sets etc.)
        if (qsetRef.type.toUpperCase() !== 'IFCELEMENTQUANTITY') continue;

        // A set that walks to zero quantities is dropped — see
        // {@link readQuantitySet}. Here that also stops an empty set from one
        // source suppressing a populated same-identity set from another, since
        // `extractTypeQuantitiesOnDemand` still dedups NAMED sets by
        // `(name, globalId)` identity (see {@link appendSetsFromSecondSource}).
        const qset = readQuantitySet(store, extractor, qsetRef);
        if (qset) result.push(qset);
    }

    return result;
}

/**
 * Extract type-level quantities for a single entity ON-DEMAND.
 * Finds the element's type via IfcRelDefinesByType, then extracts element
 * quantities from:
 * 1. The type entity's HasPropertySets attribute (index 5 on IfcTypeObject) —
 *    an IfcPropertySetDefinition list that may include IfcElementQuantity.
 * 2. The onDemandQuantityMap for the type entity (IFC4 IfcRelDefinesByProperties
 *    with an IfcElementQuantity targeting the type).
 * Returns null when the element has no type or the type carries no quantities.
 * The quantity counterpart of {@link extractTypePropertiesOnDemand}.
 */
export function extractTypeQuantitiesOnDemand(
    store: IfcDataStore,
    entityId: number,
    view?: MetadataReadView,
): TypeQuantityInfo | null {
    if (view && store.source?.length) return extractCurrentTypeQuantities(store, entityId, view);
    if (!store.relationships) return null;

    const typeIds = store.relationships.getRelated(entityId, RelationshipType.DefinesByType, 'inverse');
    if (typeIds.length === 0) return null;

    const typeId = typeIds[0];
    // @raw-entity-enumeration-ok the assigned source type comes from this relationship lookup
    const typeRef = store.entityIndex.byId.get(typeId);
    if (!typeRef || !store.source?.length) return null;
    const typeEntity = new EntityExtractor(store.source).extractEntity(typeRef);
    const typeName = typeEntity && typeof typeEntity.attributes?.[2] === 'string'
        ? typeEntity.attributes[2] : typeRef.type;
    const quantities = extractTypeEntityOwnQuantities(store, typeId);
    return quantities.length ? { typeName, typeId, quantities } : null;
}

/** Canonical source quantity sets for a selected type object or a native writer's base (#7355). */
export function extractTypeEntityOwnQuantities(
    store: IfcDataStore,
    typeId: number,
): Array<{ name: string; globalId?: string; quantities: CollectedQuantity[] }> {
    // @raw-entity-enumeration-ok point lookup for the caller's selected source type
    const typeRef = store.entityIndex.byId.get(typeId);
    if (!typeRef || !store.source?.length || !getInheritanceChain(typeRef.type).includes('IfcTypeObject')) return [];
    const extractor = new EntityExtractor(store.source);
    const typeEntity = extractor.extractEntity(typeRef);
    const allQsets: Array<{ name: string; globalId?: string; quantities: CollectedQuantity[] }> = [];
    const seenQsetKeys = new Set<string>();
    const ownSetIds = new Set<number>();

    // Source 1: HasPropertySets attribute on the type (index 5) — quantity sets
    // live alongside property sets in this IfcPropertySetDefinition list.
    if (typeEntity) {
        const hasPropertySets = typeEntity.attributes?.[5];
        if (Array.isArray(hasPropertySets)) {
            for (const id of hasPropertySets) if (typeof id === 'number') ownSetIds.add(id);
            for (const qset of extractQsetsFromIds(store, extractor, [...ownSetIds])) {
                seenQsetKeys.add(setIdentityKey(qset));
                allQsets.push(qset);
            }
        }
    }

    // Source 2: onDemandQuantityMap for the type entity (IFC4 IfcRelDefinesByProperties).
    const typeQsetIds = store.onDemandQuantityMap?.get(typeId);
    if (typeQsetIds && typeQsetIds.length > 0) {
        appendSetsFromSecondSource(allQsets, ownSetIds, seenQsetKeys, typeQsetIds,
            (ids) => extractQsetsFromIds(store, extractor, ids));
    }

    return allQsets;
}
