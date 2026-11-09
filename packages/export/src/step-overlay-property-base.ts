/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import type { PropertySet, PropertyValue, QuantitySet } from '@ifc-lite/data';
import type { PropertySetContext } from './step-property-set-readers.js';

/** A new occurrence's saved definitions are reached through its new
 * relationships, rather than its id in the immutable source's metadata map.
 * Read those definitions with the canonical parser before applying its overlay;
 * name-only virtual sets must not erase distinct saved instances (#9296). */
export function overlayPropertyBase(
  ctx: PropertySetContext, entityId: number,
  relationships: readonly { psetId: number }[] | undefined,
): { properties: PropertySet[]; quantities: QuantitySet[] } | undefined {
  const ids = [...new Set(relationships?.map(rel => rel.psetId))]
    .filter(id => ctx.dataStore.entityIndex.byId.has(id));
  if (!ids.length) return undefined;
  const source = { ...ctx.dataStore,
    onDemandPropertyMap: new Map([[entityId, ids]]),
    onDemandQuantityMap: new Map([[entityId, ids]]),
  };
  return {
    properties: extractPropertiesOnDemand(source, entityId).map(set => ({
      name: set.name, globalId: set.globalId ?? '',
      properties: set.properties.map(property => ({ ...property, value: property.value as PropertyValue })),
    })),
    quantities: extractQuantitiesOnDemand(source, entityId).map(set => ({
      // Saved identities belong to the source, not a derived set of this new owner.
      name: set.name, globalId: '', quantities: set.quantities,
    })),
  };
}
