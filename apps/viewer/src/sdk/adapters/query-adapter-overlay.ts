/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The overlay half of `bim.properties()` / `bim.quantities()` in the viewer.
 *
 * Once a session has a mutation view it is the whole answer, mutated entity
 * or not: `getForEntity` / `getQuantitiesForEntity` merge the wired
 * on-demand base with the SET/DELETE overlay — the same merge the export
 * reads. `undefined` means only "no mutation view yet" (a read-only
 * session), the one case that still falls through to the parsed store.
 *
 * Before this the adapter read `EntityNode` directly: `bim.mutate.setProperty()`
 * followed by `bim.properties()` returned the pre-edit value in the viewer
 * while the CLI (`packages/cli/src/query-overlay.ts`) had already been fixed
 * for the same defect; a flow graph that tabulated what it had just written
 * showed nulls (#5167).
 */

import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { EntityRef, PropertySetData, QuantitySetData } from '@ifc-lite/sdk';

export function overlayProperties(view: MutablePropertyView | null, ref: EntityRef): PropertySetData[] | undefined {
  if (!view) return undefined;
  if (view.isDeleted(ref.expressId)) return [];
  return view.getForEntity(ref.expressId).map((pset) => ({
    name: pset.name,
    globalId: pset.globalId,
    properties: pset.properties.map((p) => ({ name: p.name, type: p.type, value: p.value as string | number | boolean | null })),
  }));
}

export function overlayQuantities(view: MutablePropertyView | null, ref: EntityRef): QuantitySetData[] | undefined {
  if (!view) return undefined;
  if (view.isDeleted(ref.expressId)) return [];
  return view.getQuantitiesForEntity(ref.expressId).map((qset) => ({
    name: qset.name,
    quantities: qset.quantities.map((q) => ({ name: q.name, type: q.type, value: q.value })),
  }));
}
