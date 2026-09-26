/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { parsePropertyValue, type PropertySet, type QuantitySet } from './encodingUtils';
import type { MaterialPsetGroup } from '@ifc-lite/parser';

export function matchesPropertySearch(value: unknown, query: string): boolean {
  return String(value ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

/** Preserve set metadata and only remove rows that the user cannot find (#5899). */
export function filterPropertySets<T extends PropertySet>(sets: readonly T[], query: string): T[] {
  if (!query) return [...sets];
  return sets.flatMap((set) => {
    if (matchesPropertySearch(set.name, query)) return [set];
    const properties = set.properties.filter((property) =>
      matchesPropertySearch(property.name, query)
      || matchesPropertySearch(parsePropertyValue(property.value).displayValue, query),
    );
    return properties.length > 0 ? [{ ...set, properties } as T] : [];
  });
}

export function filterQuantitySets(sets: readonly QuantitySet[], query: string): QuantitySet[] {
  if (!query) return [...sets];
  return sets.flatMap((set) => {
    if (matchesPropertySearch(set.name, query)) return [set];
    const quantities = set.quantities.filter((quantity) =>
      matchesPropertySearch(quantity.name, query) || matchesPropertySearch(quantity.value, query),
    );
    return quantities.length > 0 ? [{ ...set, quantities }] : [];
  });
}

/** Material properties live on the associated material, outside occurrence and type sets. */
export function filterMaterialPropertyGroups(groups: readonly MaterialPsetGroup[], query: string) {
  return groups.flatMap((group) => {
    const psets = filterPropertySets(group.psets.map((pset) => ({
      name: pset.name,
      properties: pset.properties.map((property) => ({
        name: property.name, value: property.value, dataType: property.dataType,
      })),
    })), query);
    return psets.length > 0 ? [{ ...group, psets }] : [];
  });
}
