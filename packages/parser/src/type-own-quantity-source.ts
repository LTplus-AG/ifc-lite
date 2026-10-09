/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { EntityExtractor } from './entity-extractor.js';
import { extractCurrentTypeQuantities } from './current-type-quantities.js';
import { effectiveMetadataRecord, type MetadataReadView } from './effective-metadata-record.js';
import { RelationshipType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { readQuantitySet, readQuantitySetRecord, type CollectedQuantity, type QuantityEntityReader } from './quantity-collect.js';
import { appendSetsFromSecondSource, setIdentityKey } from './property-set-merge.js';
import type { TypeQuantityInfo } from './on-demand-extractors.js';
import { getInheritanceChain } from './ifc-schema.js';
import { resolveUnitByRef } from './project-units.js';
import { positionalMetadataValue } from './metadata-edit-value.js';

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
    const result: Array<{ name: string; globalId?: string; quantities: Array<CollectedQuantity & { explicitUnitType?: string }> }> = [];

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
    view?: MetadataReadView,
): Array<{ name: string; globalId?: string; quantities: Array<CollectedQuantity & { explicitUnitType?: string }> }> {
    if (view) return currentTypeOwnQuantities(store, typeId, view);
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

/** Native writer bases use canonical quantity decoding without losing opaque source atoms. */
function currentTypeOwnQuantities(store: IfcDataStore, typeId: number, view: MetadataReadView) {
    let reads = 0;
    const read: QuantityEntityReader = id => {
        if (++reads > 8192) throw new Error('Current type quantity entity reads exceed the limit');
        const record = effectiveMetadataRecord(store, id, view);
        if (!record) throw new Error(`Current type quantity dependency #${id} is unavailable`);
        const attributes = record.attributes.map(value => {
            if (!Array.isArray(value)) return value;
            if (value.length > 4096) throw new Error('Current type quantity attribute references exceed the limit');
            return value.map(positionalMetadataValue);
        });
        return { ...record, attributes, expressId: id };
    };
    const refs = (value: unknown, max: number, optional = false): number[] => {
        if (optional && value === null) return [];
        if (!Array.isArray(value) || value.length > max || (!optional && value.length === 0)
            || value.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
            throw new Error('Current type quantity references are unreadable or exceed the limit');
        }
        return value;
    };
    const type = read(typeId);
    if (!type || !getInheritanceChain(type.type).includes('IfcTypeObject')) throw new Error('Current quantity owner is not an available IfcTypeObject');
    const definitions = refs(type.attributes[5], 256, true);
    const extractor = new EntityExtractor(store.source);
    let unitReads = 0;
    const units = new Map<number, ReturnType<typeof resolveUnitByRef>>();
    const resolveUnit = (id: number) => {
        if (units.has(id)) return units.get(id)!;
        const unit = resolveUnitByRef(extractor, store.entityIndex, id, unitId => {
            if (++unitReads > 512) throw new Error('Current type quantity unit reads exceed the limit');
            return read(unitId);
        });
        if (!unit || !Number.isFinite(unit.resolved.siScale) || unit.resolved.siScale <= 0) throw new Error('Current type quantity explicit unit is unavailable');
        units.set(id, unit);
        return unit;
    };
    let references = 0;
    const result: Array<{ name: string; globalId?: string; quantities: Array<CollectedQuantity & { explicitUnitType?: string }> }> = [];
    for (const id of definitions) {
        const set = read(id);
        if (!set) throw new Error('Current type quantity definition is unavailable');
        if (set.type.toUpperCase() !== 'IFCELEMENTQUANTITY') {
            if (getInheritanceChain(set.type).includes('IfcPropertySetDefinition')) continue;
            throw new Error('Current type definition is not an IfcPropertySetDefinition');
        }
        const members = refs(set.attributes[5], 4096 - references); references += members.length;
        const unitTypes = new Map<string, string>();
        for (const member of members) {
            const quantity = read(member);
            if (!quantity || !getInheritanceChain(quantity.type).includes('IfcPhysicalQuantity')) throw new Error('Current type physical quantity is unavailable');
            if (getInheritanceChain(quantity.type).includes('IfcPhysicalSimpleQuantity')) {
                const unit = quantity.attributes[2];
                if (unit !== null && (typeof unit !== 'number' || !Number.isSafeInteger(unit) || unit <= 0)) throw new Error('Current type quantity unit reference is unreadable');
                if (typeof unit === 'number') {
                    const resolved = resolveUnit(unit);
                    if (typeof quantity.attributes[0] === 'string' && resolved.unitType) unitTypes.set(quantity.attributes[0], resolved.unitType);
                }
                if (typeof quantity.attributes[3] !== 'number' || !Number.isFinite(quantity.attributes[3])) throw new Error('Current type quantity measure is unreadable');
            }
        }
        const decoded = readQuantitySetRecord(store, extractor, set, read, resolveUnit);
        if (decoded) result.push({ ...decoded, quantities: decoded.quantities.map(quantity => {
            const explicitUnitType = unitTypes.get(quantity.name);
            return explicitUnitType ? { ...quantity, explicitUnitType } : quantity;
        }) });
    }
    return result;
}
