/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The boxes `element.align` lines up (charter #6232, C4): each element's
 * footprint in the session workplane, read off its rendered meshes (so an
 * imported element aligns like an authored one), and the shift that brings one
 * box's chosen edge onto another's.
 *
 * Edges are the workplane's own axes, as the plan draws them: Left / Centre /
 * Right along its u axis, Top / Middle / Bottom along v (up the plan).
 */

import type { MeshData } from '@ifc-lite/geometry';
import { effectiveSpatialMembers } from '@/lib/effective-spatial-members';
import { toGlobalIdFromModels } from '@/store/globalId';
import { meshesForOwningModel, type OwningModelMeshSource } from '@/store/owningModelMeshes';
import type { ViewerState } from '@/store';
import type { Workplane } from './types.js';

import { planBoxOf, type PlanBox } from '@ifc-lite/create';
export { ALIGN_MODES, alignsAlongU, planBoxOf, pickBox, edgeOf, alignShift, shiftBox, type AlignMode, type PlanBox } from '@ifc-lite/create';

/**
 * The meshes `modelId` renders: its own, or the top-level mirror only when it
 * IS the active model. Mesh ids are global ids (`idOffset + express id`), so
 * another model's meshes must never stand in (#4929, `owningModelMeshes.ts`).
 */
export function modelMeshes(s: OwningModelMeshSource, modelId: string): readonly MeshData[] {
  return meshesForOwningModel(s, modelId) ?? [];
}

/** Every element contained in `storeyId` that has geometry to line up, by express id. */
export function storeyBoxes(s: ViewerState, modelId: string, storeyId: number, plane: Workplane): Map<number, PlanBox> {
  const store = s.models.get(modelId)?.ifcDataStore;
  const boxes = new Map<number, PlanBox>();
  if (!store) return boxes;
  const meshes = modelMeshes(s, modelId);
  for (const expressId of effectiveSpatialMembers(store, s.mutationViews.get(modelId), storeyId)) {
    const box = planBoxOf(meshes, toGlobalIdFromModels(s.models, modelId, expressId), plane);
    if (box) boxes.set(expressId, box);
  }
  return boxes;
}

