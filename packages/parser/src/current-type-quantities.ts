/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntities, QuantityType } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { EntityExtractor } from './entity-extractor.js';
import { effectiveMetadataRecord, type MetadataReadView } from './effective-metadata-record.js';
import { getInheritanceChain } from './ifc-schema.js';
import { QUANTITY_TYPE_MAP } from './columnar-parser-indexes.js';
import { resolveUnitByRef, type UnitEntityReader } from './project-units.js';
import { readQuantitySetRecord, type QuantityEntityReader } from './quantity-collect.js';
import { appendSetsFromSecondSource, setIdentityKey } from './property-set-merge.js';
import type { TypeQuantityInfo } from './on-demand-extractors.js';

const MAX_RELATIONSHIPS = 65_536;
const MAX_RELATION_REFERENCES = 262_144;
const MAX_TYPE_DEFINITIONS = 256;
const MAX_QUANTITY_REFERENCES = 4_096;
const MAX_UNIT_READS = 512;

export interface CurrentTypeQuantityResult {
    status: 'available' | 'unavailable';
    reason: string | null;
    value: TypeQuantityInfo | null;
}
const available = (value: TypeQuantityInfo | null): CurrentTypeQuantityResult => ({ status: 'available', reason: null, value });
const unavailable = (reason: string): CurrentTypeQuantityResult => ({ status: 'unavailable', reason, value: null });
class CurrentQuantityRefusal extends Error {}
function refIds(value: unknown, max = MAX_RELATION_REFERENCES, required = false): number[] {
    if (value === null || (Array.isArray(value) && value.length === 0)) {
        if (required) throw new CurrentQuantityRefusal('Native required quantity references are unreadable');
        return [];
    }
    if (Array.isArray(value) && value.length > max) throw new CurrentQuantityRefusal('Native quantity references exceed the read limit');
    if (!Array.isArray(value) || value.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)) {
        throw new CurrentQuantityRefusal('Native quantity references are unreadable');
    }
    return value;
}

interface CurrentInventory {
    revision: number;
    source: IfcDataStore['source'];
    types: Map<number, number[]>;
    sets: Map<number, number[]>;
    quantities: Map<number, CurrentTypeQuantityResult>;
}
const inventories = new WeakMap<IfcDataStore, WeakMap<MetadataReadView, CurrentInventory>>();

function inventory(store: IfcDataStore, view: MetadataReadView): CurrentInventory {
    let views = inventories.get(store);
    if (!views) { views = new WeakMap(); inventories.set(store, views); }
    const revision = view.getMutationRevision();
    const old = views.get(view);
    if (old?.revision === revision && old.source === store.source) return old;
    const result: CurrentInventory = { revision, source: store.source, types: new Map(), sets: new Map(), quantities: new Map() };
    let relationshipCount = 0;
    let referenceCount = 0;
    for (const row of iterateEffectiveEntities(store, view, ['IfcRelDefinesByType', 'IfcRelDefinesByProperties'])) {
        if (++relationshipCount > MAX_RELATIONSHIPS) throw new CurrentQuantityRefusal('Native type relationship inventory exceeds the read limit');
        const record = effectiveMetadataRecord(store, row.expressId, view);
        if (!record) throw new CurrentQuantityRefusal('Native type relationship is unreadable');
        const target = record.attributes[5];
        const members = refIds(record.attributes[4], MAX_RELATION_REFERENCES, true);
        referenceCount += members.length;
        if (referenceCount > MAX_RELATION_REFERENCES) throw new CurrentQuantityRefusal('Native type relationship references exceed the read limit');
        if (typeof target !== 'number' || !Number.isSafeInteger(target) || target <= 0) throw new CurrentQuantityRefusal('Native type relationship target is unreadable');
        const map = record.type.toUpperCase() === 'IFCRELDEFINESBYTYPE' ? result.types : result.sets;
        for (const id of members) {
            const ids = map.get(id) ?? [];
            if (!ids.includes(target)) ids.push(target);
            map.set(id, ids);
        }
    }
    views.set(view, result);
    return result;
}

/** Current native reads distinguish verified empty facts from unavailable coverage (#7353). */
export function readCurrentTypeQuantities(store: IfcDataStore, entityId: number, view: MetadataReadView): CurrentTypeQuantityResult {
    try {
        return readCurrent(store, entityId, view);
    } catch (error) {
        if (error instanceof CurrentQuantityRefusal) return unavailable(error.message);
        console.warn('[type quantities] Native current quantity read failed', error);
        return unavailable('Native current type quantities are unreadable');
    }
}

/** Nullable compatibility path; callers needing coverage use readCurrentTypeQuantities. */
export function extractCurrentTypeQuantities(store: IfcDataStore, entityId: number, view: MetadataReadView): TypeQuantityInfo | null {
    return readCurrentTypeQuantities(store, entityId, view).value;
}

function readCurrent(store: IfcDataStore, entityId: number, view: MetadataReadView): CurrentTypeQuantityResult {
    if (view.isDeleted(entityId)) return available(null);
    const current = inventory(store, view);
    const typeId = current.types.get(entityId)?.[0];
    if (typeId === undefined) return available(null);
    if (current.quantities.has(typeId)) return current.quantities.get(typeId)!;
    const type = effectiveMetadataRecord(store, typeId, view);
    if (!type || !getInheritanceChain(type.type).includes('IfcTypeObject')) return unavailable('Native assigned type is unavailable or unsupported');
    const extractor = new EntityExtractor(store.source);
    const readEntity: QuantityEntityReader = (id) => {
        const record = effectiveMetadataRecord(store, id, view);
        return record ? { ...record, expressId: id } : null;
    };
    let unitReads = 0;
    const readUnitEntity: UnitEntityReader = id => {
        if (++unitReads > MAX_UNIT_READS) throw new CurrentQuantityRefusal('Native quantity unit dependencies exceed the read limit');
        const record = readEntity(id);
        if (!record) throw new CurrentQuantityRefusal('Native quantity unit dependency is unreadable');
        return record;
    };
    const units = new Map<number, ReturnType<typeof resolveUnitByRef>>();
    const resolveCurrentUnit = (id: number) => {
        if (units.has(id)) return units.get(id)!;
        const unit = resolveUnitByRef(extractor, store.entityIndex, id, readUnitEntity);
        if (!unit || !Number.isFinite(unit.resolved.siScale) || unit.resolved.siScale <= 0) throw new CurrentQuantityRefusal('Native quantity unit is unresolved or unsupported');
        units.set(id, unit);
        return unit;
    };
    const definitions = refIds(type.attributes[type.names.indexOf('HasPropertySets')], MAX_TYPE_DEFINITIONS);
    const relatedDefinitions = current.sets.get(typeId) ?? [];
    if (definitions.length + relatedDefinitions.length > MAX_TYPE_DEFINITIONS) return unavailable('Native type quantity definitions exceed the read limit');
    const ownSetIds = new Set(definitions);
    let quantityReferences = 0;
    const readSets = (ids: number[]) => ids.flatMap(id => {
        if (view.isDeleted(id)) return [];
        const record = readEntity(id);
        if (!record) throw new CurrentQuantityRefusal('Native type quantity definition is unreadable');
        if (record.type.toUpperCase() !== 'IFCELEMENTQUANTITY') {
            if (getInheritanceChain(record.type).includes('IfcPropertySetDefinition')) return [];
            throw new CurrentQuantityRefusal('Native type quantity definition is unsupported');
        }
        const refs = refIds(record.attributes[5], MAX_QUANTITY_REFERENCES - quantityReferences, true);
        quantityReferences += refs.length;
        if (quantityReferences > MAX_QUANTITY_REFERENCES) throw new CurrentQuantityRefusal('Native type quantity references exceed the read limit');
        for (const ref of refs) {
            if (view.isDeleted(ref)) continue;
            const quantity = readEntity(ref);
            if (!quantity || QUANTITY_TYPE_MAP[quantity.type.toUpperCase()] === undefined) throw new CurrentQuantityRefusal('Native type quantity class is unavailable or unsupported');
            const unit = quantity.attributes[2];
            if (unit !== null && (typeof unit !== 'number' || !Number.isSafeInteger(unit) || unit <= 0)) throw new CurrentQuantityRefusal('Native quantity unit reference is unreadable');
            if (typeof quantity.attributes[0] !== 'string' || !quantity.attributes[0]) throw new CurrentQuantityRefusal('Native type quantity name is unavailable');
            if (typeof quantity.attributes[3] !== 'number' || !Number.isFinite(quantity.attributes[3])
                || (quantity.attributes[3] < 0 && QUANTITY_TYPE_MAP[quantity.type.toUpperCase()] !== QuantityType.Number)) throw new CurrentQuantityRefusal('Native type quantity value is unavailable');
        }
        const set = readQuantitySetRecord(store, extractor, record, readEntity, resolveCurrentUnit);
        if (set?.quantities.some(quantity => quantity.explicitUnitUnresolved)) {
            throw new CurrentQuantityRefusal('Native quantity unit is unresolved or dimensionally unsupported');
        }
        return set ? [set] : [];
    });
    const quantities = readSets([...ownSetIds]);
    const keys = new Set(quantities.map(setIdentityKey));
    appendSetsFromSecondSource(quantities, ownSetIds, keys, relatedDefinitions, readSets);
    const result = available(quantities.length ? { typeName: typeof type.attributes[2] === 'string' ? type.attributes[2] : type.type, typeId, quantities } : null);
    current.quantities.set(typeId, result);
    return result;
}
