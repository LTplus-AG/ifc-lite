/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Write a planned storey re-level into a draft (#9013): placement lifts,
 * storey Elevation attributes, attached-wall heights (with their base
 * quantities), the tops of attached columns, beams and curtain walls, stair
 * refits and the railings that run up them. Callers own the atomic transaction; a throw
 * here means nothing is published.
 */

import { refreshTopAttachmentsInStore } from '../top-attachment-refresh.js';
import type { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { extractProjectUnits, extractQuantitiesOnDemand, quantitySiScale, type IfcDataStore, type ProjectUnits } from '@ifc-lite/parser';
import type { QuantityType } from '@ifc-lite/data';
import { refitStairRailing } from '../railing-stair-refit.js';
import { editStairDimensionsInStore, readStairDimensions } from '../stair-edit.js';
import { writeAttachedTop } from './storey-attached.js';
import { setWallSectionInStore } from '../wall-section-edit.js';
import { readWallMetres } from '../wall-size-edit.js';
import type { StoreyLevelPlan } from './storey-level-plan.js';
import { writeShiftedPlacement } from './storey-placement.js';
import { StoreyEditRefusedError } from './storey-validation.js';

export const WALL_QTO = 'Qto_WallBaseQuantities';

/** How many `Qto_WallBaseQuantities` instances a wall has, source ones included. Only the first is kept true by a resize. */
export function wallQuantitySetCount(store: IfcDataStore, view: MutablePropertyView, wallId: number): number {
  const base = view.hasQuantityBase() ? undefined : (id: number) => extractQuantitiesOnDemand(store, id);
  return view.getQuantitiesForEntity(wallId, base).filter((set) => set.name === WALL_QTO).length;
}

/** Returns every product whose mesh the write changed beyond a pure move. */
export function writeStoreyLevelPlan(store: IfcDataStore, draft: StoreEditor, plan: StoreyLevelPlan): number[] {
  const reshaped: number[] = [];
  for (const write of plan.placements) writeShiftedPlacement(draft, write.leaf, write.offset);
  for (const storey of plan.storeys) {
    draft.setPositionalAttribute(storey.expressId, 9, { real: Math.round(storey.elevationAttribute * 1e9) / 1e9 });
  }
  const view = draft.getMutationView();
  for (const wall of plan.walls) {
    const geometry = wallGeometry(store, view, draft, wall.wallId);
    const outcome = setWallSectionInStore({ dataStore: store, view, editor: draft }, wall.wallId, { height: wall.to });
    if (!outcome.ok) {
      throw new StoreyEditRefusedError([{ code: 'dependent', elementIds: [wall.wallId], message: `Wall #${wall.wallId} cannot follow its storey: ${outcome.reason}` }]);
    }
    scaleWallQuantities(store, view, wall.wallId, wall.to / wall.from, geometry);
    reshaped.push(...outcome.remesh);
  }
  const target = { dataStore: store, view, editor: draft };
  for (const element of plan.attached) {
    const outcome = writeAttachedTop(target, element.elementId, element.kind, element.from, element.to);
    if (!outcome.ok) {
      throw new StoreyEditRefusedError([{ code: 'dependent', elementIds: [element.elementId], message: `#${element.elementId} cannot follow its level: ${outcome.reason}` }]);
    }
    reshaped.push(...outcome.remesh);
  }
  // Railings first: they are found on the stair as it stands before its refit.
  for (const railing of plan.railings) {
    const stair = plan.stairs.find((candidate) => candidate.stairId === railing.stairId);
    const dims = readStairDimensions(store, railing.stairId, view);
    if (!stair || !dims) continue;
    const before = { stairId: stair.stairId, run: dims.NumberOfRisers * dims.TreadLength, rise: dims.NumberOfRisers * dims.RiserHeight, width: dims.Width };
    const reason = refitStairRailing(target, railing.railingId, before, { run: stair.to.NumberOfRisers * dims.TreadLength, rise: stair.to.NumberOfRisers * stair.to.RiserHeight });
    if (reason) throw new StoreyEditRefusedError([{ code: 'dependent', elementIds: [railing.railingId], message: `The railing #${railing.railingId} cannot follow its stair: ${reason}` }]);
    reshaped.push(railing.railingId);
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
  reshaped.push(...refreshTopAttachmentsInStore(target, plan.moved, plan.walls.map(wall => wall.wallId)));
  return [...new Set(reshaped)];
}

/**
 * Keep an existing Qto_WallBaseQuantities true to a height change by factor
 * `k`. A wall is a prism along its height, so Height and the gross side area
 * and volume scale by `k`; the net values lose the same openings before and
 * after, so they change by exactly the gross change. Unit-free, since every
 * value keeps the unit it was written in. A wall without the set gets none.
 * A view with no quantity base of its own reads the source quantities here,
 * so a set that exists only in the file is kept true too. Without a gross
 * value, the set's Length, Height and Width give the gross prism, else the
 * wall's own `geometry` (metres, read before the resize).
 */
export function scaleWallQuantities(
  store: IfcDataStore, view: MutablePropertyView, wallId: number, k: number, geometry?: WallGeometry,
): void {
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
  // The set's own dimensions first (they are what its other values were measured with), then the wall's geometry.
  const grossFromSet = {
    GrossSideArea: length !== undefined && h !== undefined ? length * h
      : geometry ? geometry.length * geometry.height : undefined,
    GrossVolume: length !== undefined && width !== undefined && h !== undefined ? length * width * h
      : geometry ? geometry.length * geometry.thickness * geometry.height : undefined,
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

/** A wall's prism in metres (SI), for quantity upkeep. */
export interface WallGeometry { readonly length: number; readonly thickness: number; readonly height: number }

/** The wall's length, thickness and height before a resize, or undefined when it cannot be read. */
export function wallGeometry(store: IfcDataStore, view: MutablePropertyView, editor: StoreEditor, wallId: number): WallGeometry | undefined {
  const wall = readWallMetres({ dataStore: store, view, editor }, wallId);
  if (!wall) return undefined;
  const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1], wall.end[2] - wall.start[2]);
  return [length, wall.thickness, wall.height].every((v) => Number.isFinite(v) && v > 0)
    ? { length, thickness: wall.thickness, height: wall.height } : undefined;
}
