/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A list quantity cell is one number in the project's unit for that measure:
 * the export conversion and the Sum aggregate both assume it. An
 * `IfcPhysicalSimpleQuantity` that declares its own `Unit` (5,000,000 mm2 in a
 * square-metre project) is stored raw, so without this step it is summed as if
 * it were 5,000,000 m2. Re-express such a quantity in the project's unit.
 *
 * A member `Unit` that does not resolve yields NaN (never an inherited guess);
 * the list engine renders a non-finite quantity as an empty cell.
 *
 * The conversion lives in `createProjectUnitListDataProvider`, used where list
 * and schedule values are produced. The plain `createListDataProvider` keeps
 * `explicitUnitSiScale` on every quantity because the chart reader, the zone
 * volume basis and the unit display read the base scale from it.
 */

import { ProjectUnits, extractProjectUnits, quantitySiScale } from '@ifc-lite/parser';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { Quantity, QuantitySet } from '@ifc-lite/data';
import type { ListDataProvider } from '@ifc-lite/lists';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { createListDataProvider, type ZoneListContext } from './adapter.js';

const unitsByStore = new WeakMap<IfcDataStore, ProjectUnits>();

function projectUnits(store: IfcDataStore): ProjectUnits {
  let units = unitsByStore.get(store);
  if (!units) {
    units = store.source.length > 0 ? extractProjectUnits(store.source, store.entityIndex) : ProjectUnits.empty();
    unitsByStore.set(store, units);
  }
  return units;
}

function ownScaleOf(quantity: Quantity): number | undefined {
  if (quantity.explicitUnitUnresolved === true) return Number.NaN;
  return quantity.explicitUnitSiScale;
}

const declaresOwnUnit = (quantity: Quantity): boolean => ownScaleOf(quantity) !== undefined;

function quantitySetsInProjectUnits(store: IfcDataStore, sets: QuantitySet[]): QuantitySet[] {
  if (!sets.some(set => set.quantities.some(declaresOwnUnit))) return sets;
  const units = projectUnits(store);
  return sets.map(set => ({
    ...set,
    quantities: set.quantities.map(quantity => {
      const ownScale = ownScaleOf(quantity);
      if (ownScale === undefined) return quantity;
      const { explicitUnitSiScale: _scale, explicitUnitUnresolved: _unresolved, explicitUnit: _symbol, ...own } = quantity;
      // `own` carries no explicit unit, so this is the project's scale for the quantity's type.
      const projectScale = quantitySiScale(own, units);
      // Keep the precision of the numeric cell used by sums and exports.
      const value = ownScale === projectScale ? quantity.value : quantity.value * (ownScale / projectScale);
      return { ...own, value };
    }),
  }));
}

/**
 * The list/schedule data provider: `createListDataProvider` plus each quantity
 * that declares its own `Unit` re-expressed in the project's unit. Charts read
 * the unconverted `createListDataProvider`.
 */
export function createProjectUnitListDataProvider(
  store: IfcDataStore,
  modelName = '',
  zoneContext?: ZoneListContext,
  view?: MutablePropertyView,
): ListDataProvider {
  const provider = createListDataProvider(store, modelName, zoneContext, view);
  return {
    ...provider,
    getQuantitySets: (id) => quantitySetsInProjectUnits(store, provider.getQuantitySets(id)),
    getTypeQuantitySets: provider.getTypeQuantitySets && ((id) => quantitySetsInProjectUnits(store, provider.getTypeQuantitySets!(id))),
  };
}
