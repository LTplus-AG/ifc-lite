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
import { RelationshipType, type QuantitySet } from '@ifc-lite/data';
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

type ExplicitQuantity = QuantitySet['quantities'][number] & {
  explicitUnitSiScale?: number;
  explicitUnitUnresolved?: true;
};

/** The overlay side of a conversion: who owns the sets and what the unedited source says. */
interface OverlayScope {
  view: MutablePropertyView;
  /** The entity whose quantity edits apply (the occurrence, or its defining type). */
  owner: number;
  /** The same sets read from the native source, before overlay edits drop the explicit-unit metadata. */
  base: () => QuantitySet[];
}

function ownScaleOf(quantity: ExplicitQuantity): number | undefined {
  if (quantity.explicitUnitUnresolved === true) return Number.NaN;
  return quantity.explicitUnitSiScale;
}

export function quantitySetsInProjectUnits(store: IfcDataStore, sets: QuantitySet[], overlay?: OverlayScope): QuantitySet[] {
  const declares = (q: ExplicitQuantity) => ownScaleOf(q) !== undefined;
  const mayBeEdited = overlay?.view.hasChanges(overlay.owner) === true;
  if (!mayBeEdited && !sets.some(set => set.quantities.some(q => declares(q as ExplicitQuantity)))) return sets;
  const units = projectUnits(store);
  const baseSets = mayBeEdited ? overlay.base() : [];
  return sets.map(set => ({
    ...set,
    quantities: set.quantities.map(q => {
      const quantity = q as ExplicitQuantity;
      let ownScale = ownScaleOf(quantity);
      if (ownScale === undefined && mayBeEdited && !quantity.unit
        && overlay.view.getQuantityMutation(overlay.owner, set.name, q.name)?.unitRemoved !== true) {
        // An overlay-edited quantity is rebuilt without the collector's scale, but
        // its number stays in the quantity's own unit unless the edit named another
        // (the chart reader's `explicitScaleFor` applies the same rule).
        const base = baseSets.find(candidate => candidate.name === set.name)?.quantities.find(candidate => candidate.name === q.name);
        if (base) ownScale = ownScaleOf(base as ExplicitQuantity);
      }
      if (ownScale === undefined) return q;
      const { explicitUnitSiScale: _scale, explicitUnitUnresolved: _unresolved, explicitUnit: _symbol, ...own } = quantity as ExplicitQuantity & { explicitUnit?: string };
      const projectScale = quantitySiScale({ name: q.name, type: q.type, value: q.value } as Parameters<typeof quantitySiScale>[0], units);
      // One multiply by the ratio, rounded to 12 significant digits: mm and m
      // quantities of the same size must land on the same number, or a Group by
      // would split them over float noise.
      return { ...own, value: Number((q.value * (ownScale / projectScale)).toPrecision(12)) };
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
  const source = view ? createListDataProvider(store) : provider;
  const definingTypeId = (id: number): number =>
    store.relationships?.getRelated(id, RelationshipType.DefinesByType, 'inverse')[0] ?? -1;
  return {
    ...provider,
    getQuantitySets: (id) => quantitySetsInProjectUnits(store, provider.getQuantitySets(id),
      view && { view, owner: id, base: () => source.getQuantitySets(id) }),
    getTypeQuantitySets: provider.getTypeQuantitySets && ((id) => quantitySetsInProjectUnits(store, provider.getTypeQuantitySets!(id),
      view && { view, owner: definingTypeId(id), base: () => source.getTypeQuantitySets!(id) })),
  };
}
