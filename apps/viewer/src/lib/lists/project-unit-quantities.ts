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
 */

import { ProjectUnits, extractProjectUnits, quantitySiScale } from '@ifc-lite/parser';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { QuantitySet } from '@ifc-lite/data';

const unitsByStore = new WeakMap<IfcDataStore, ProjectUnits>();

function projectUnits(store: IfcDataStore): ProjectUnits {
  let units = unitsByStore.get(store);
  if (!units) {
    units = store.source.length > 0 ? extractProjectUnits(store.source, store.entityIndex) : ProjectUnits.empty();
    unitsByStore.set(store, units);
  }
  return units;
}

type ExplicitQuantity = QuantitySet['quantities'][number] & {
  explicitUnitSiScale?: number;
  explicitUnitUnresolved?: true;
};

export function quantitySetsInProjectUnits(store: IfcDataStore, sets: QuantitySet[]): QuantitySet[] {
  const declares = (q: ExplicitQuantity) => q.explicitUnitSiScale !== undefined || q.explicitUnitUnresolved === true;
  if (!sets.some(set => set.quantities.some(q => declares(q as ExplicitQuantity)))) return sets;
  const units = projectUnits(store);
  return sets.map(set => ({
    ...set,
    quantities: set.quantities.map(q => {
      const quantity = q as ExplicitQuantity;
      if (!declares(quantity)) return q;
      const { explicitUnitSiScale, explicitUnitUnresolved, explicitUnit: _symbol, ...own } = quantity as ExplicitQuantity & { explicitUnit?: string };
      const ownScale = explicitUnitUnresolved ? Number.NaN : explicitUnitSiScale!;
      const projectScale = quantitySiScale({ name: q.name, type: q.type, value: q.value } as Parameters<typeof quantitySiScale>[0], units);
      return { ...own, value: q.value * ownScale / projectScale };
    }),
  }));
}
