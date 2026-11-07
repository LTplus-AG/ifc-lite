/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Write a planned storey re-level into a draft (#9013): placement lifts,
 * storey Elevation attributes, attached-wall heights (with their base
 * quantities) and stair refits. Callers own the atomic transaction; a throw
 * here means nothing is published.
 */

import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { extractProjectUnits, extractQuantitiesOnDemand, quantitySiScale, type IfcDataStore, type ProjectUnits } from '@ifc-lite/parser';
import type { QuantityType } from '@ifc-lite/data';
import { editStairDimensionsInStore } from '../stair-edit.js';
import { setWallSectionInStore } from '../wall-section-edit.js';
import type { StoreyLevelPlan } from './storey-level-plan.js';
import { writeShiftedPlacement } from './storey-placement.js';
import { StoreyEditRefusedError } from './storey-validation.js';

const WALL_QTO = 'Qto_WallBaseQuantities';

/** Returns every product whose mesh the write changed beyond a pure move. */
export function writeStoreyLevelPlan(store: IfcDataStore, draft: StoreEditor, plan: StoreyLevelPlan): number[] {
  const reshaped: number[] = [];
  for (const write of plan.placements) writeShiftedPlacement(draft, write.leaf, write.offset);
  for (const storey of plan.storeys) {
    draft.setPositionalAttribute(storey.expressId, 9, { real: Math.round(storey.elevationAttribute * 1e9) / 1e9 });
  }
  const view = draft.getMutationView();
  for (const wall of plan.walls) {
    const outcome = setWallSectionInStore({ dataStore: store, view, editor: draft }, wall.wallId, { height: wall.to });
    if (!outcome.ok) {
      throw new StoreyEditRefusedError([{ code: 'dependent', elementIds: [wall.wallId], message: `Wall #${wall.wallId} cannot follow its storey: ${outcome.reason}` }]);
    }
    scaleWallQuantities(store, view, wall.wallId, wall.to / wall.from);
    reshaped.push(...outcome.remesh);
  }
  for (const stair of plan.stairs) {
    try {
      editStairDimensionsInStore(store, draft, stair.stairId, stair.to);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new StoreyEditRefusedError([{ code: 'dependent', elementIds: [stair.stairId], message: `The stair #${stair.stairId} has no valid flight for the new height: ${reason}` }]);
    }
    reshaped.push(stair.stairId, stair.flightId);
  }
  return [...new Set(reshaped)];
}

/**
 * Keep an existing Qto_WallBaseQuantities true to a height change by factor
 * `k`. A wall is a prism along its height, so Height and the gross side area
 * and volume scale by `k`; the net values lose the same openings before and
 * after, so they change by exactly the gross change. Unit-free, since every
 * value keeps the unit it was written in. A wall without the set gets none.
 * A view with no quantity base of its own reads the source quantities here,
 * so a set that exists only in the file is kept true too.
 */
export function scaleWallQuantities(store: IfcDataStore, view: MutablePropertyView, wallId: number, k: number): void {
  const base = view.hasQuantityBase() ? undefined : (id: number) => extractQuantitiesOnDemand(store, id);
  const qto = view.getQuantitiesForEntity(wallId, base).find((set) => set.name === WALL_QTO);
  if (!qto || !Number.isFinite(k)) return;
  const value = (name: string) => qto.quantities.find((q) => q.name === name);
  const set = (name: string, next: number) => {
    const quantity = value(name);
    if (quantity && Number.isFinite(next)) view.setQuantity(wallId, WALL_QTO, name, next, quantity.type, quantity.unit);
  };
  const height = value('Height');
  if (height) set('Height', height.value * k);
  // Quantities may carry their own unit (a NetSideArea in mm² beside a GrossSideArea in m²):
  // the arithmetic between them runs in SI, each read through its own scale.
  let units: ProjectUnits | null = null;
  const scaleOf = (q: { name: string; type: QuantityType; value: number } | undefined): number | undefined => {
    if (!q) return undefined;
    units ??= extractProjectUnits(store.source, store.entityIndex);
    const explicit = 'explicitUnitSiScale' in q && typeof q.explicitUnitSiScale === 'number' ? { explicitUnitSiScale: q.explicitUnitSiScale } : {};
    const scale = quantitySiScale({ name: q.name, type: q.type, value: q.value, ...explicit }, units);
    return Number.isFinite(scale) && scale > 0 ? scale : undefined;
  };
  const si = (q: { name: string; type: QuantityType; value: number } | undefined): number | undefined => {
    const scale = scaleOf(q);
    return q && scale !== undefined ? q.value * scale : undefined;
  };
  // Without the gross value, the set's own Length × Height (× Width) is the gross prism it stands for.
  const length = si(value('Length')), width = si(value('Width')), h = si(height);
  const grossFromSet = {
    GrossSideArea: length !== undefined && h !== undefined ? length * h : undefined,
    GrossVolume: length !== undefined && width !== undefined && h !== undefined ? length * width * h : undefined,
  };
  for (const [gross, net] of [['GrossSideArea', 'NetSideArea'], ['GrossVolume', 'NetVolume']] as const) {
    const g = value(gross), n = value(net);
    if (g) set(gross, g.value * k);
    if (!n) continue;
    // Openings are the same before and after, so the net value changes by exactly the gross change.
    const beforeSi = si(g) ?? grossFromSet[gross];
    const netScale = scaleOf(n);
    set(net, beforeSi !== undefined && netScale !== undefined ? n.value + beforeSi * (k - 1) / netScale : n.value * k);
  }
}
