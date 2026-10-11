/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from './columnar-parser.js';
import { EntityExtractor } from './entity-extractor.js';
import { getEntityRefFromStore } from './columnar-parser-root-attributes.js';
import { effectiveMetadataRecord, type MetadataReadView } from './effective-metadata-record.js';
import { resolveUnitByRef, type UnitEntityReader } from './project-units.js';
import { readQuantitySet, readQuantitySetRecord, type QuantityEntityReader, type CollectedQuantity } from './quantity-collect.js';
import { OccurrenceQuantityReadError } from './occurrence-quantity-read-error.js';

const MAX_SETS = 256;
const MAX_MEMBERS = 4_096;
const MAX_UNIT_READS = 512;

/** Source occurrence ownership remains canonical; its native member Unit and
 * dependencies must reflect the current view rather than the original bytes
 * (#7379). Effective metadata records invalidate their memo on every revision,
 * including Undo, and when the source store is rebound. */
export function readOccurrenceQuantities(
    store: IfcDataStore,
    qsetIds: readonly number[],
    view?: MetadataReadView,
): Array<{ name: string; globalId?: string; quantities: CollectedQuantity[] }> {
    if (!view) {
        const extractor = new EntityExtractor(store.source);
        return qsetIds.flatMap(id => {
            const ref = getEntityRefFromStore(store, id);
            const set = ref ? readQuantitySet(store, extractor, ref) : null;
            return set ? [set] : [];
        });
    }
    if (qsetIds.length > MAX_SETS) {
        throw new OccurrenceQuantityReadError('Native occurrence quantity sets exceed the read limit');
    }
    const extractor = new EntityExtractor(store.source);
    const readEntity: QuantityEntityReader = id => {
        const record = effectiveMetadataRecord(store, id, view);
        return record ? { ...record, expressId: id } : null;
    };
    let unitReads = 0;
    let reportedLimit = false;
    const readUnit: UnitEntityReader = id => {
        if (++unitReads > MAX_UNIT_READS) {
            if (!reportedLimit) console.warn('[occurrence quantities] Native unit dependencies exceed the read limit');
            reportedLimit = true;
            return null;
        }
        const record = readEntity(id);
        if (record?.attributes.some(value => Array.isArray(value) && value.length > MAX_MEMBERS)) {
            console.warn('[occurrence quantities] Native unit references exceed the read limit');
            return null;
        }
        return record;
    };
    const units = new Map<number, ReturnType<typeof resolveUnitByRef>>();
    const resolveUnit = (id: number) => {
        if (units.has(id)) return units.get(id) ?? null;
        const unit = resolveUnitByRef(extractor, store.entityIndex, id, readUnit);
        units.set(id, unit);
        return unit;
    };
    const result: Array<{ name: string; globalId?: string; quantities: CollectedQuantity[] }> = [];
    let members = 0;
    for (const id of qsetIds) {
        const record = readEntity(id);
        if (!record || record.type.toUpperCase() !== 'IFCELEMENTQUANTITY') continue;
        const refs = record.attributes[5];
        if (!Array.isArray(refs) || (members += refs.length) > MAX_MEMBERS) {
            throw new OccurrenceQuantityReadError('Native occurrence quantity members are unreadable or exceed the read limit');
        }
        const set = readQuantitySetRecord(store, extractor, record, readEntity, resolveUnit);
        if (set) result.push(set);
    }
    return result;
}
