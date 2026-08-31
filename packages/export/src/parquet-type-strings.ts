/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `PropertyValueType`/`QuantityType` enum -> Parquet column string, shared
 * between `ParquetExporter`'s bulk-table writers (`parquet-exporter.ts`) and
 * its on-demand fallback (`parquet-exporter-ondemand.ts`) so `Properties.
 * PropType` and `Quantities.QuantityType` read the same strings regardless
 * of which path produced the row.
 */

import { PropertyValueType, QuantityType } from '@ifc-lite/data';

export function propertyValueTypeToString(type: PropertyValueType): string {
    const names: Record<PropertyValueType, string> = {
        [PropertyValueType.String]: 'String',
        [PropertyValueType.Real]: 'Real',
        [PropertyValueType.Integer]: 'Integer',
        [PropertyValueType.Boolean]: 'Boolean',
        [PropertyValueType.Logical]: 'Logical',
        [PropertyValueType.Label]: 'Label',
        [PropertyValueType.Identifier]: 'Identifier',
        [PropertyValueType.Text]: 'Text',
        [PropertyValueType.Enum]: 'Enum',
        [PropertyValueType.Reference]: 'Reference',
        [PropertyValueType.List]: 'List',
    };
    return names[type] || 'Unknown';
}

export function quantityTypeToString(type: QuantityType): string {
    const names: Record<QuantityType, string> = {
        [QuantityType.Length]: 'Length',
        [QuantityType.Area]: 'Area',
        [QuantityType.Volume]: 'Volume',
        [QuantityType.Count]: 'Count',
        [QuantityType.Weight]: 'Weight',
        [QuantityType.Time]: 'Time',
        [QuantityType.Number]: 'Number',
    };
    return names[type] || 'Unknown';
}
