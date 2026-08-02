/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Set-shaped property/quantity matching for `EntityQuery.whereProperty`.
 *
 * Used only when the store's columnar property table is empty and the filter
 * has to be answered from resolved `PropertySet[]` / `QuantitySet[]` instead
 * (the STEP on-demand shape, see `applyPropertyFilters`). The comparison itself
 * is `comparePropertyValues` from `@ifc-lite/data` — the same function
 * `PropertyTable.findByProperty` uses — so the two strategies cannot drift.
 *
 * Internal to the package: not re-exported from `index.ts`.
 */

import { comparePropertyValues, type PropertySet, type PropertyValue, type QuantitySet } from '@ifc-lite/data';

/**
 * True when ANY property named `propName`, in ANY property set named
 * `psetName`, satisfies `operator`/`value`.
 *
 * ANY-match rather than first-match is what `findByProperty` does: it walks
 * every row of that property name. A model may legitimately carry the same
 * property in two same-named sets (two `IfcRelDefinesByProperties` pointing at
 * distinct `IfcPropertySet`s), and stopping at the first hit would answer
 * differently from the table path for exactly those entities.
 */
export function matchesPsetFilter(
  psets: readonly PropertySet[],
  psetName: string,
  propName: string,
  operator: string,
  value: PropertyValue,
): boolean {
  for (const pset of psets) {
    if (pset.name !== psetName) continue;
    for (const prop of pset.properties) {
      if (prop.name !== propName) continue;
      if (comparePropertyValues(prop.value, operator, value)) return true;
    }
  }
  return false;
}

/**
 * True when ANY quantity named `quantityName`, in ANY quantity set named
 * `qsetName`, satisfies `operator`/`value`.
 *
 * `Quantity.value` is always a number, so only the numeric branch of
 * `comparePropertyValues` can fire here.
 */
export function matchesQsetFilter(
  qsets: readonly QuantitySet[],
  qsetName: string,
  quantityName: string,
  operator: string,
  value: PropertyValue,
): boolean {
  for (const qset of qsets) {
    if (qset.name !== qsetName) continue;
    for (const quantity of qset.quantities) {
      if (quantity.name !== quantityName) continue;
      if (comparePropertyValues(quantity.value, operator, value)) return true;
    }
  }
  return false;
}
