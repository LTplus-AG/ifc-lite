/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PropertySet, QuantitySet } from './encodingUtils';
import type { MaterialPsetGroup, ProjectUnits } from '@ifc-lite/parser';
import { propertyDisplayValue, quantityDisplayValue } from './propertyDisplayValue';

export function foldPropertySearchText(value: string): string {
  return [...value].map((character) => character.toLocaleLowerCase()).join('');
}

export function matchesPropertySearch(value: unknown, query: string): boolean {
  if (!query) return true;
  return foldPropertySearchText(String(value ?? '')).includes(foldPropertySearchText(query));
}

/** Preserve set metadata and only remove rows that the user cannot find (#5899). */
export function filterPropertySets<T extends PropertySet>(sets: readonly T[], query: string, units: ProjectUnits, overrides: Record<string, string>): T[] {
  if (!query) return [...sets];
  return sets.flatMap((set) => {
    if (matchesPropertySearch(set.name, query)) return [set];
    const properties = set.properties.filter((property) => {
      if (matchesPropertySearch(property.name, query)) return true;
      const display = propertyDisplayValue(property, units, overrides);
      return matchesPropertySearch(display.full, query) || matchesPropertySearch(display.parsed.displayValue, query);
    });
    return properties.length > 0 ? [{ ...set, properties } as T] : [];
  });
}

export function filterQuantitySets(sets: readonly QuantitySet[], query: string, units: ProjectUnits, overrides: Record<string, string>, locale: string): QuantitySet[] {
  if (!query) return [...sets];
  return sets.flatMap((set) => {
    if (matchesPropertySearch(set.name, query)) return [set];
    const quantities = set.quantities.filter((quantity) =>
      matchesPropertySearch(quantity.name, query)
      || matchesPropertySearch(quantityDisplayValue(quantity, units, overrides, locale), query)
      || matchesPropertySearch(quantity.value, query),
    );
    return quantities.length > 0 ? [{ ...set, quantities }] : [];
  });
}

/** Material properties live on the associated material, outside occurrence and type sets. */
export function filterMaterialPropertyGroups(groups: readonly MaterialPsetGroup[], query: string, units: ProjectUnits, overrides: Record<string, string>) {
  return groups.flatMap((group) => {
    const psets = filterPropertySets(group.psets.map((pset) => ({
      name: pset.name,
      properties: pset.properties.map((property) => ({
        name: property.name, value: property.value, dataType: property.dataType,
      })),
    })), query, units, overrides);
    return psets.length > 0 ? [{ ...group, psets }] : [];
  });
}

/** Keep a search hit visible when it lives on the other Properties tab. */
export function searchTabForHits(tab: string, hasQuantities: boolean, hasProperties: boolean): 'properties' | 'quantities' | null {
  if (tab === 'quantities' && !hasQuantities && hasProperties) return 'properties';
  if (tab !== 'quantities' && hasQuantities && !hasProperties) return 'quantities';
  if (tab !== 'properties' && tab !== 'quantities' && hasProperties) return 'properties';
  return null;
}
