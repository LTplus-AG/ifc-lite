/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Properties.parquet` / `Quantities.parquet` writers for the on-demand parse
 * path, extracted from `ParquetExporter` (`parquet-exporter.ts`) to keep that
 * file under its module-size budget.
 *
 * `IfcParser.parseColumnar` (`packages/parser`'s only parse path, used by
 * every real caller) never calls `.add()` on the `PropertyTableBuilder`/
 * `QuantityTableBuilder` it constructs — properties and quantities are served
 * lazily through `onDemandPropertyMap`/`onDemandQuantityMap` +
 * `store.getProperties()`/`store.getQuantities()` instead
 * (`extractPropertiesOnDemand`/`extractQuantitiesOnDemand`, re-parsing the
 * source buffer on access). `ParquetExporter`'s bulk-table writers read
 * `store.properties`/`store.quantities` directly, which is only populated
 * when a caller builds a store some other way (e.g. this package's own
 * hand-built test fixtures) — every store from a real parse left those two
 * tables at zero rows, silently, alongside a fully-populated
 * `Entities.parquet`/`Relationships.parquet`. These two functions are the
 * on-demand fallback `ParquetExporter` calls when the bulk table is empty:
 * one flat row per property/quantity, read through the same
 * `store.getProperties()`/`store.getQuantities()` accessor every other
 * consumer (the query package, the viewer's property panel) uses — never a
 * second copy of the pset/property walk.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { PropertyValueType, type QuantityType } from '@ifc-lite/data';
import type { EffectiveEntityIndex } from './effective-index.js';
import { columnsToParquet } from './columns-to-parquet.js';
import { PARQUET_UINT32_COLUMNS } from './parquet-uint32-columns.js';
import { propertyValueTypeToString, quantityTypeToString } from './parquet-type-strings.js';

export async function writePropertiesOnDemand(
    store: IfcDataStore,
    effective: EffectiveEntityIndex | null,
): Promise<Uint8Array> {
    const entityIdCol: number[] = [];
    const psetNameCol: string[] = [];
    const psetGlobalIdCol: string[] = [];
    const propNameCol: string[] = [];
    const propTypeCol: PropertyValueType[] = [];
    const valueStringCol: (string | null)[] = [];
    // `IfcPropertyBoundedValue` is surfaced as a display string but retains
    // the REAL type tag. Only a scalar numeric value belongs in ValueReal;
    // writing 0 for the display-string form fabricates a measurement.
    const valueRealCol: (number | null)[] = [];
    const valueIntCol: number[] = [];
    const valueBoolCol: (boolean | null)[] = [];

    for (const id of store.onDemandPropertyMap!.keys()) {
        if (effective?.isDeleted(id)) continue;
        const psets = store.getProperties(id);
        for (const pset of psets) {
            for (const prop of pset.properties) {
                entityIdCol.push(id);
                psetNameCol.push(pset.name);
                psetGlobalIdCol.push(pset.globalId ?? '');
                propNameCol.push(prop.name);
                propTypeCol.push(prop.type);
                const v = prop.value;
                valueStringCol.push(typeof v === 'string' ? v : null);
                valueRealCol.push(prop.type === PropertyValueType.Real && typeof v === 'number' ? v : null);
                valueIntCol.push(prop.type === PropertyValueType.Integer && typeof v === 'number' ? v : 0);
                valueBoolCol.push(typeof v === 'boolean' ? v : null);
            }
        }
    }

    return columnsToParquet({
        EntityId: entityIdCol,
        PsetName: psetNameCol,
        PsetGlobalId: psetGlobalIdCol,
        PropName: propNameCol,
        PropType: propTypeCol.map(t => propertyValueTypeToString(t)),
        ValueString: valueStringCol,
        ValueReal: valueRealCol,
        ValueInt: valueIntCol,
        ValueBool: valueBoolCol,
    }, new Set(['ValueReal']), PARQUET_UINT32_COLUMNS);
}

/**
 * `Formula` is always NULL here: the on-demand quantity reader
 * (`readQuantitySet` in `@ifc-lite/parser`) reports only
 * `{name, type, value}` per quantity, so there is no formula string to carry
 * — `ParquetExporter`'s bulk-table path is the only one that can populate it.
 */
export async function writeQuantitiesOnDemand(
    store: IfcDataStore,
    effective: EffectiveEntityIndex | null,
): Promise<Uint8Array> {
    const entityIdCol: number[] = [];
    const qsetNameCol: string[] = [];
    const quantityNameCol: string[] = [];
    const quantityTypeCol: QuantityType[] = [];
    const valueCol: number[] = [];
    const formulaCol: (string | null)[] = [];

    for (const id of store.onDemandQuantityMap!.keys()) {
        if (effective?.isDeleted(id)) continue;
        const qsets = store.getQuantities(id);
        for (const qset of qsets) {
            for (const q of qset.quantities) {
                entityIdCol.push(id);
                qsetNameCol.push(qset.name);
                quantityNameCol.push(q.name);
                quantityTypeCol.push(q.type);
                valueCol.push(q.value);
                formulaCol.push(q.formula ?? null);
            }
        }
    }

    return columnsToParquet({
        EntityId: entityIdCol,
        QsetName: qsetNameCol,
        QuantityName: quantityNameCol,
        QuantityType: quantityTypeCol.map(t => quantityTypeToString(t)),
        Value: valueCol,
        Formula: formulaCol,
    }, new Set(['Value']), PARQUET_UINT32_COLUMNS);
}
