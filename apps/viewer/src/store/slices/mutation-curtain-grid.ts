/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Curtain walls and design grids (charter #6232, D3): the write path behind
 * the Model workspace's `curtainwall.place` and `grid.place` commands.
 *
 * A curtain wall is an aggregate: the IfcCurtainWall, its IfcMember mullions
 * and transoms, its IfcPlate panels, the IfcRelAggregates that ties them and
 * the storey containment, with placements, profiles and shapes. A grid is the
 * IfcGrid with its tagged IfcGridAxis curves and containment. Either writes
 * through `recordModellingEdit`, which runs the in-store builder atomically
 * against the model's live editor and puts every record it wrote on the undo
 * stack, so one Ctrl+Z removes the whole graph; in a shared room the overlay
 * delta is published. The enclosing modeling transaction tags the batch and
 * re-meshes the parts (#6391); on its own the action leaves that to its caller.
 *
 * These are plain functions over a store handle, not `mutationSlice` actions:
 * the slice composes them the day it wants `tx.store.addCurtainWall`.
 */

import {
  addCurtainWallToStore,
  addGridToStore,
  resolveSpatialAnchor,
  type CurtainWallBuildResult,
  type CurtainWallInStoreParams,
  type GridBuildResult,
  type GridInStoreParams,
} from '@ifc-lite/create';
import type { StoreEditor } from '@ifc-lite/mutations';
import { registerAuthoredElement } from '@/utils/spatialHierarchy.js';
import { mutationDenial } from '../mutation-permission.js';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from './mutation-modelling-records.js';
import { ensureStoreyPlacement } from './storeyPlacement.js';

export type CurtainWallOutcome =
  | { readonly expressId: number; readonly partIds: readonly number[]; readonly build: CurtainWallBuildResult }
  | { readonly error: string };

export type GridOutcome =
  | { readonly expressId: number; readonly build: GridBuildResult }
  | { readonly error: string };

/** Model-local names of what one curtain wall is made of, for the storey tree. */
const PART_TYPE = { member: 'IFCMEMBER', plate: 'IFCPLATE' } as const;

/** Run `build` against the model's editor and the storey's anchor as one recorded edit. */
function writeOnStorey<T>(
  store: ModellingStore,
  modelId: string,
  storeyId: number,
  build: (editor: StoreEditor, anchor: ReturnType<typeof resolveSpatialAnchor>) => T,
): T | { error: string } {
  const get = store.getState;
  const denial = mutationDenial(get(), modelId);
  if (denial) return { error: denial };
  const target = modelEditTarget(get(), modelId);
  if (!target) return { error: `No model loaded for id "${modelId}"` };
  try {
    return recordModellingEdit(store, modelId, (_methods, draft) => {
      // A storey without an ObjectPlacement (optional in the schema) gets one at the origin.
      ensureStoreyPlacement(target.dataStore, draft, storeyId);
      return build(draft, resolveSpatialAnchor(target.dataStore, storeyId, draft.getMutationView()));
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** List `entityId` in the storey's spatial tree under its authored name. */
function listInStorey(store: ModellingStore, modelId: string, storeyId: number, entityId: number, ifcType: string): void {
  const target = modelEditTarget(store.getState(), modelId);
  const hierarchy = target?.dataStore.spatialHierarchy;
  if (!target || !hierarchy) return;
  const name = target.view.getNewEntity(entityId)?.attributes?.[2];
  registerAuthoredElement(hierarchy, storeyId, entityId, ifcType, typeof name === 'string' ? name : '');
}

export function addCurtainWallIn(
  store: ModellingStore,
  modelId: string,
  storeyId: number,
  params: CurtainWallInStoreParams,
): CurtainWallOutcome {
  const built = writeOnStorey(store, modelId, storeyId, (editor, anchor) => addCurtainWallToStore(editor, anchor, params));
  if ('error' in built) return built;
  const partIds = [...built.mullionIds, ...built.transomIds, ...built.panelIds];
  // The curtain wall is the storey's element; its parts join it so Solo and
  // isolation of the storey see them, and undo and redo keep the rows in step.
  completeCurtainWallHierarchy(store, modelId, storeyId, built);
  return { expressId: built.curtainWallId, partIds, build: built };
}

export function addGridIn(
  store: ModellingStore,
  modelId: string,
  storeyId: number,
  params: GridInStoreParams,
): GridOutcome {
  const built = writeOnStorey(store, modelId, storeyId, (editor, anchor) => addGridToStore(editor, anchor, params));
  if ('error' in built) return built;
  listInStorey(store, modelId, storeyId, built.gridId, 'IFCGRID');
  return { expressId: built.gridId, build: built };
}

/** Publish the same complete native aggregate hierarchy for SDK and reviewed transactions. */
export function completeCurtainWallHierarchy(store: ModellingStore, modelId: string, storeyId: number, built: CurtainWallBuildResult): void {
  listInStorey(store, modelId, storeyId, built.curtainWallId, 'IFCCURTAINWALL');
  for (const id of [...built.mullionIds, ...built.transomIds]) listInStorey(store, modelId, storeyId, id, PART_TYPE.member);
  for (const id of built.panelIds) listInStorey(store, modelId, storeyId, id, PART_TYPE.plate);
}
