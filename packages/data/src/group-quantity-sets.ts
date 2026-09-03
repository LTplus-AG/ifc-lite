/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StringTable } from './string-table.js';
import type { QuantitySet, Quantity } from './quantity-table.js';
import type { QuantityType } from './types.js';

/**
 * Group a row-index list into `QuantitySet`s keyed on `(qsetName, qsetGlobalId)`,
 * not name alone -- two `IfcElementQuantity` instances that share a literal
 * name (a federated merge, or an exporter emitting the same Qto_ set twice on
 * one element) must stay distinct, or the second instance's quantities come
 * back attributed to the first instance's GlobalId. Mirrors
 * `groupPropertySetsByInstance` (same defect, same fix, on the property
 * side). Shared by the live `QuantityTable.getForEntity` (in
 * `quantity-table.ts`) and by `@ifc-lite/cache`'s cache-rehydrated
 * `readQuantities`, which reads the same columnar arrays back from the
 * binary cache -- a single grouping algorithm keeps the two paths from
 * diverging.
 */
export function groupQuantitySetsByInstance(
  rowIndices: readonly number[],
  qsetName: Uint32Array,
  qsetGlobalId: Uint32Array,
  quantityName: Uint32Array,
  quantityType: Uint8Array,
  value: Float64Array,
  formula: Uint32Array,
  strings: StringTable,
): QuantitySet[] {
  const qsets = new Map<string, QuantitySet>();
  for (const idx of rowIndices) {
    const qsetNameStr = strings.get(qsetName[idx]);
    const qsetGlobalIdStr = strings.get(qsetGlobalId[idx]);
    const key = qsetNameStr + '\u0000' + qsetGlobalIdStr;
    if (!qsets.has(key)) {
      qsets.set(key, { name: qsetNameStr, globalId: qsetGlobalIdStr, quantities: [] });
    }
    const qset = qsets.get(key)!;
    const quant: Quantity = {
      name: strings.get(quantityName[idx]),
      type: quantityType[idx] as QuantityType,
      value: value[idx],
      formula: formula[idx] > 0 ? strings.get(formula[idx]) : undefined,
    };
    qset.quantities.push(quant);
  }
  return Array.from(qsets.values());
}
