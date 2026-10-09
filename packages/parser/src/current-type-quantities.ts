/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { iterateEffectiveEntities } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { EntityExtractor } from './entity-extractor.js';
import { effectiveMetadataRecord, type MetadataReadView } from './effective-metadata-record.js';
import { getInheritanceChain } from './ifc-schema.js';
import { readQuantitySetRecord, type QuantityEntityReader } from './quantity-collect.js';
import { appendSetsFromSecondSource, setIdentityKey } from './property-set-merge.js';
import type { TypeQuantityInfo } from './on-demand-extractors.js';

function refIds(value: unknown): number[] {
    return Array.isArray(value) ? value.filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0) : [];
}

interface CurrentInventory {
    revision: number;
    source: IfcDataStore['source'];
    types: Map<number, number[]>;
    sets: Map<number, number[]>;
    quantities: Map<number, TypeQuantityInfo | null>;
}
const inventories = new WeakMap<IfcDataStore, WeakMap<MetadataReadView, CurrentInventory>>();

function inventory(store: IfcDataStore, view: MetadataReadView): CurrentInventory {
    let views = inventories.get(store);
    if (!views) { views = new WeakMap(); inventories.set(store, views); }
    const revision = view.getMutationRevision();
    const old = views.get(view);
    if (old?.revision === revision && old.source === store.source) return old;
    const result: CurrentInventory = { revision, source: store.source, types: new Map(), sets: new Map(), quantities: new Map() };
    for (const row of iterateEffectiveEntities(store, view, ['IfcRelDefinesByType', 'IfcRelDefinesByProperties'])) {
        const record = effectiveMetadataRecord(store, row.expressId, view);
        if (!record) continue;
        const target = record.attributes[5];
        if (typeof target !== 'number' || !Number.isSafeInteger(target) || target <= 0) continue;
        const map = record.type.toUpperCase() === 'IFCRELDEFINESBYTYPE' ? result.types : result.sets;
        for (const id of refIds(record.attributes[4])) {
            const ids = map.get(id) ?? [];
            if (!ids.includes(target)) ids.push(target);
            map.set(id, ids);
        }
    }
    views.set(view, result);
    return result;
}

/** Current native type and quantity records, using the source collector's units/schema/numeric rules. */
export function extractCurrentTypeQuantities(store: IfcDataStore, entityId: number, view: MetadataReadView): TypeQuantityInfo | null {
    if (view.isDeleted(entityId)) return null;
    const current = inventory(store, view);
    const typeId = current.types.get(entityId)?.[0];
    if (typeId === undefined) return null;
    if (current.quantities.has(typeId)) return current.quantities.get(typeId) ?? null;
    const type = effectiveMetadataRecord(store, typeId, view);
    if (!type || !getInheritanceChain(type.type).includes('IfcTypeObject')) return null;
    const extractor = new EntityExtractor(store.source);
    const readEntity: QuantityEntityReader = (id) => {
        const record = effectiveMetadataRecord(store, id, view);
        return record ? { ...record, expressId: id } : null;
    };
    const ownSetIds = new Set(refIds(type.attributes[5]));
    const readSets = (ids: number[]) => ids.flatMap(id => {
        const record = readEntity(id);
        if (record?.type.toUpperCase() !== 'IFCELEMENTQUANTITY') return [];
        const set = readQuantitySetRecord(store, extractor, record, readEntity);
        return set ? [set] : [];
    });
    const quantities = readSets([...ownSetIds]);
    const keys = new Set(quantities.map(setIdentityKey));
    appendSetsFromSecondSource(quantities, ownSetIds, keys, current.sets.get(typeId) ?? [], readSets);
    const result = quantities.length ? { typeName: typeof type.attributes[2] === 'string' ? type.attributes[2] : type.type, typeId, quantities } : null;
    current.quantities.set(typeId, result);
    return result;
}
