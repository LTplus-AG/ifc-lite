/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PropertySet } from '@ifc-lite/data';
import type { IfcDataStore } from './columnar-parser.js';
import { extractPropertiesOnDemand, extractQuantitiesOnDemand } from './columnar-parser.js';
import { BufferEntitySource } from './entity-source.js';

/**
 * An assembled store before its lazy accessor methods are attached — every
 * data field of an {@link IfcDataStore} except the four accessors.
 */
export type IfcStoreData = Omit<
  IfcDataStore,
  'getEntity' | 'getEntitiesByType' | 'getProperties' | 'getQuantities'
>;

/**
 * Attach the lazy `getEntity` / `getEntitiesByType` / `getProperties` /
 * `getQuantities` accessors to an assembled store, in place, and return it.
 *
 * These accessors lazily read entity/property/quantity data from the store's
 * `source` buffer (via the on-demand maps + byte index) rather than from
 * pre-materialised tables, so every store-construction path must attach them.
 * There are three such paths — the fresh columnar parse, the worker→main
 * transport reconstruction, and the on-disk cache restore — and this helper is
 * the single home for the wiring so they can never drift apart. (A cache
 * restore that skipped this shipped a store missing `getEntity`, which crashed
 * the Properties panel via `EntityNode.allAttributes`.)
 *
 * Requires `source`, `entityIndex`, and the on-demand maps to already be
 * populated on `store`.
 */
export function attachDataStoreAccessors(store: IfcStoreData): IfcDataStore {
  const full = store as IfcDataStore;
  const entitySource = new BufferEntitySource(full.source, full.entityIndex);

  full.getEntity = (expressId) => entitySource.getEntity(expressId);
  full.getEntitiesByType = (typeName) => entitySource.getEntitiesByType(typeName);
  full.getProperties = (expressId) => {
    if (full.onDemandPropertyMap && full.onDemandPropertyMap.size > 0) {
      // extractPropertiesOnDemand returns a richer pset shape (extra type/value
      // metadata); narrow to the PropertySet[] the store contract exposes.
      return extractPropertiesOnDemand(full, expressId) as PropertySet[];
    }
    return full.properties.getForEntity(expressId);
  };
  full.getQuantities = (expressId) => {
    if (full.onDemandQuantityMap && full.onDemandQuantityMap.size > 0) {
      return extractQuantitiesOnDemand(full, expressId);
    }
    return full.quantities.getForEntity(expressId);
  };

  return full;
}
