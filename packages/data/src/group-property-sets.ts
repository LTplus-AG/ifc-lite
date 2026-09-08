/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StringTable } from './string-table.js';
import type { PropertySet, PropertyValue } from './property-table.js';

/**
 * Group a row-index list into `PropertySet`s keyed on `(psetName, psetGlobalId)`,
 * not name alone -- two `IfcPropertySet` instances that share a literal name
 * (a federated merge, or an exporter emitting the same Pset_ twice on one
 * element) must stay distinct, or the second instance's properties come back
 * attributed to the first instance's GlobalId. Shared by the live
 * `PropertyTable.getForEntity` (in `property-table.ts`) and by
 * `@ifc-lite/cache`'s cache-rehydrated `readProperties`, which reads the same
 * columnar arrays back from the binary cache -- a single grouping algorithm
 * keeps the two paths from re-diverging.
 */
export function groupPropertySetsByInstance(
  rowIndices: readonly number[],
  psetName: Uint32Array,
  psetGlobalId: Uint32Array,
  propName: Uint32Array,
  propType: Uint8Array,
  strings: StringTable,
  getValue: (idx: number) => PropertyValue,
): PropertySet[] {
  const psets = new Map<string, PropertySet>();
  for (const idx of rowIndices) {
    const psetNameStr = strings.get(psetName[idx]), psetGlobalIdStr = strings.get(psetGlobalId[idx]);
    const key = psetNameStr + '\u0000' + psetGlobalIdStr;
    if (!psets.has(key)) {
      psets.set(key, { name: psetNameStr, globalId: psetGlobalIdStr, properties: [] });
    }
    const pset = psets.get(key)!;
    const propNameStr = strings.get(propName[idx]);
    pset.properties.push({
      name: propNameStr,
      type: propType[idx],
      value: getValue(idx),
    });
  }
  return Array.from(psets.values());
}
