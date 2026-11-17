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
import { extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { refitStairRailing } from '../railing-stair-refit.js';
import { editStairDimensionsInStore, readStairDimensions } from '../stair-edit.js';
import { writeAttachedTop } from './storey-attached.js';
import type { StoreyLevelPlan } from './storey-level-plan.js';
import { writeShiftedPlacement } from './storey-placement.js';
import { StoreyEditRefusedError } from './storey-validation.js';

import { WALL_QTO } from './wall-height-quantities.js';

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
    const outcome = writeAttachedTop({ dataStore: store, view, editor: draft }, wall.wallId, 'wall', wall.from, wall.to);
    if (!outcome.ok) {
      throw new StoreyEditRefusedError([{ code: 'dependent', elementIds: [wall.wallId], message: `Wall #${wall.wallId} cannot follow its storey: ${outcome.reason}` }]);
    }
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
