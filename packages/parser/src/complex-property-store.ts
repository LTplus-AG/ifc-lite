/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcComplexProperty` values, resolved ONCE per store (#7675).
 *
 * The bulk paths (lists, IDS, compare, collab seed, rules) call
 * `extractPropertiesOnDemand` once per entity. When each call walked a shared
 * complex property again with its own budget, a set shared by 60 walls cost
 * 2 GB of heap from an 18.6 KB file, and 200 walls ran out of memory. So
 * every complex property a property set lists is resolved here once, against
 * one budget for the whole model sized to its source, and every caller gets
 * the same value object back.
 *
 * The order is the policy `ifc_lite_core::limits::complex_property_output_budget`
 * documents for all three copies: property sets in file order, each set id
 * once at its LAST record (keep-last, the record core's entity index reads),
 * then `HasProperties` order. A complex property id is walked once, at its
 * first listing; a repeat listing reuses that value, charged only what it
 * keeps (`ComplexPropertyBudget.listing`). The server's extraction and the
 * Rust exporter's `BaseSets` resolve the same way, so the budget cuts the same
 * listing in every copy, and which entity asks first changes nothing.
 *
 * The shared values are frozen, so a caller that mutates one throws instead
 * of changing what every other entity reads.
 */

import type { EntityExtractor } from './entity-extractor.js';
import type { IfcDataStore } from './columnar-parser.js';
import type { ParsedIfcPropertyValue } from './property-value-parser.js';
import {
    ComplexPropertyBudget,
    COMPLEX_PROPERTY_BUDGET_MARKER,
    complexPropertyListingBytes,
    resolveComplexPropertyValue,
} from './property-complex-value.js';
import { PropertyValueType } from '@ifc-lite/data';

interface StoreComplexValues {
    /** Set id -> `HasProperties` index -> value. */
    byListing: Map<number, Map<number, ParsedIfcPropertyValue>>;
    /** Levels the model's budget cut (D3: counted and logged once). */
    cuts: number;
}

const resolvedByStore = new WeakMap<IfcDataStore, StoreComplexValues>();

/**
 * The value of the complex property `psetId` lists at `HasProperties[index]`,
 * from the store-wide pass. The returned object (and its `values` /
 * `members`) is shared by every caller: read it, do not mutate it.
 */
export function complexPropertyListingValue(
    store: IfcDataStore,
    extractor: EntityExtractor,
    psetId: number,
    index: number
): ParsedIfcPropertyValue {
    const resolved = storeComplexValues(store, extractor).byListing.get(psetId)?.get(index);
    // Unreachable for a set `extractPsetsFromIds` reads, since the pass walks the
    // same sets. Spent rather than walked with a budget of its own, which would
    // reopen #7675.
    return resolved ?? spentListing();
}

/** A listing the budget refused (or, unreachably, one the pass did not walk):
 *  a cut level with no parts, its `values` and `members` the marker alone. */
function spentListing(): ParsedIfcPropertyValue {
    return freezeShared({
        type: PropertyValueType.String,
        value: COMPLEX_PROPERTY_BUDGET_MARKER,
        structure: 'complex',
        values: [COMPLEX_PROPERTY_BUDGET_MARKER],
        members: [{ name: COMPLEX_PROPERTY_BUDGET_MARKER, type: PropertyValueType.String, value: COMPLEX_PROPERTY_BUDGET_MARKER }],
    });
}

/** Freeze a shared value with its lists, nested members too. */
function freezeShared<T extends ParsedIfcPropertyValue>(value: T): T {
    if (Object.isFrozen(value)) return value;
    if (value.values) Object.freeze(value.values);
    if (value.valueDataTypes) Object.freeze(value.valueDataTypes);
    if (value.members) {
        for (const member of value.members) freezeShared(member);
        Object.freeze(value.members);
    }
    return Object.freeze(value);
}

/** How many complex-property levels the store's budget has cut (0 before any
 *  complex property was read). */
export function complexPropertyCuts(store: IfcDataStore): number {
    return resolvedByStore.get(store)?.cuts ?? 0;
}

function storeComplexValues(store: IfcDataStore, extractor: EntityExtractor): StoreComplexValues {
    const hit = resolvedByStore.get(store);
    if (hit) return hit;
    const budget = ComplexPropertyBudget.forInput(store.source?.length ?? 0);
    const byListing = new Map<number, Map<number, ParsedIfcPropertyValue>>();
    const memo = new Map<number, [ParsedIfcPropertyValue, number]>();
    // @raw-entity-enumeration-ok the store-wide complex-property pass reads every source property set once, in file order (#7675)
    const psetIds = store.entityIndex.byType.get('IFCPROPERTYSET') ?? [];
    // A repeated set id is read once, at its last record (keep-last, as core
    // and the Rust passes read it).
    const lastAt = new Map<number, number>();
    psetIds.forEach((id, at) => lastAt.set(id, at));
    for (let at = 0; at < psetIds.length; at++) {
        const psetId = psetIds[at];
        if (lastAt.get(psetId) !== at) continue;
        // @raw-entity-enumeration-ok one source set id from the pass above is decoded from its STEP span
        const psetRef = store.entityIndex.byId.get(psetId);
        if (!psetRef) continue;
        const hasProperties = extractor.extractEntity(psetRef)?.attributes?.[4];
        if (!Array.isArray(hasProperties)) continue;
        for (let index = 0; index < hasProperties.length; index++) {
            const ref = hasProperties[index];
            if (typeof ref !== 'number') continue;
            // @raw-entity-enumeration-ok one referenced property id is typed from the index, decoded only when complex
            const propRef = store.entityIndex.byId.get(ref) ?? store.deferredEntityIndex?.get(ref);
            if (!propRef || propRef.type.toUpperCase() !== 'IFCCOMPLEXPROPERTY') continue;
            const propEntity = extractor.extractEntity(propRef);
            // Listed under a Name (empty or not), as the Rust passes resolve it.
            if (!propEntity || typeof propEntity.attributes?.[0] !== 'string') continue;
            let listings = byListing.get(psetId);
            if (!listings) {
                listings = new Map();
                byListing.set(psetId, listings);
            }
            const value = budget.listing(memo, ref, b => {
                const resolved = freezeShared(resolveComplexPropertyValue(store, extractor, propEntity, b));
                const shown = resolved.value == null ? '' : String(resolved.value);
                return [resolved, complexPropertyListingBytes(shown, resolved.values ?? [])];
            }, spentListing);
            listings.set(index, value);
        }
    }
    const resolved: StoreComplexValues = { byListing, cuts: budget.cuts };
    resolvedByStore.set(store, resolved);
    if (resolved.cuts > 0) {
        console.warn(
            `[ifc-lite] ${resolved.cuts} IfcComplexProperty value(s) were cut by the walk budget (#7675); each ends with its marker.`
        );
    }
    return resolved;
}
