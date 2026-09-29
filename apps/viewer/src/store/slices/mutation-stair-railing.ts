/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stairs and railings written into the model (charter #6232, D1): the one
 * write path behind the Model workspace's `stair.place` and `railing.place`
 * commands, over `@ifc-lite/create`'s in-store builders (#6466).
 *
 * A stair is a compound graph (the IfcStair, the IfcStairFlight it
 * aggregates, their placements, the stepped profile and body, and the two
 * relationships), a railing a shorter one. Both are written through
 * `recordModellingEdit`, which runs the builder atomically and puts every
 * record it wrote on the undo stack, so one Ctrl+Z removes the whole graph
 * and, in a shared room, the overlay delta is published.
 *
 * The elements are listed in the spatial tree under their storey (the flight
 * resolves the storey through its stair, like an aggregated part of a loaded
 * file). Their meshes come from the re-mesh of the written IFC (#6391): inside
 * a transaction (`batchId` given) the transaction re-meshes the commit; on its
 * own the action does it, for undo and redo too.
 *
 * Only IFC2X3, IFC4 and IFC4X3 models take them (decision D2): the builders
 * refuse IFC5 themselves, an IFCX file has no STEP source to write into.
 */

import {
  addRailingToStore,
  addStairToStore,
  resolveSpatialAnchor,
  type RailingInStoreParams,
  type StairInStoreParams,
} from '@ifc-lite/create';
import type { StoreEditor } from '@ifc-lite/mutations';
import { registerAuthoredElement } from '@/utils/spatialHierarchy.js';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';
import { mutationDenial } from '../mutation-permission.js';
import type { ViewerState } from '../index.js';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from './mutation-modelling-records.js';
import { ensureStoreyPlacement } from './storeyPlacement.js';

export type StairRailingOutcome =
  | { readonly expressId: number; readonly flightId?: number }
  | { readonly error: string };

export interface StairRailingOptions {
  /** The modeling transaction's batch: it tags and re-meshes the commit, so the action does neither. */
  readonly batchId?: string;
}

/** Why a model cannot take a stair or a railing at all, or null. */
export function stairRailingRefusal(state: ViewerState, modelId: string): string | null {
  const dataStore = state.models.get(modelId)?.ifcDataStore;
  if (!dataStore) return `No model loaded for id "${modelId}"`;
  const schema = String(dataStore.schemaVersion ?? 'IFC4').toUpperCase();
  if (schema === 'IFC5' || !dataStore.source || dataStore.source.byteLength === 0) {
    return 'Stairs and railings are authored in IFC2X3, IFC4 and IFC4X3 models only';
  }
  return null;
}

interface Written { readonly expressId: number; readonly flightId?: number }

function write(
  store: ModellingStore,
  modelId: string,
  storeyId: number,
  options: StairRailingOptions,
  ifcType: 'IFCSTAIR' | 'IFCRAILING',
  build: (draft: StoreEditor, anchor: ReturnType<typeof resolveSpatialAnchor>) => Written,
): StairRailingOutcome {
  const get = store.getState;
  const refusal = mutationDenial(get(), modelId) ?? stairRailingRefusal(get(), modelId);
  if (refusal) return { error: refusal };
  const undoBefore = get().undoStacks.get(modelId)?.length ?? 0;
  let written: Written;
  try {
    written = recordModellingEdit(store, modelId, (_methods, draft) => {
      const target = modelEditTarget(get(), modelId);
      if (!target) throw new Error(`No model loaded for id "${modelId}"`);
      // A storey with no placement of its own still takes elements: give it the origin one.
      ensureStoreyPlacement(target.dataStore, draft, storeyId);
      return build(draft, resolveSpatialAnchor(target.dataStore, storeyId, draft.getMutationView()));
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const state = get();
  const target = modelEditTarget(state, modelId);
  const hierarchy = target?.dataStore.spatialHierarchy;
  if (hierarchy) {
    const name = target?.view.getNewEntity(written.expressId)?.attributes?.[2];
    registerAuthoredElement(hierarchy, storeyId, written.expressId, ifcType, typeof name === 'string' ? name : '');
    // The flight is the stair's aggregated part: it sits on the storey through the stair.
    if (written.flightId !== undefined) hierarchy.elementToStorey.set(written.flightId, storeyId);
  }

  if (options.batchId === undefined) {
    // The batch `recordModellingEdit` just recorded: its last mutation's tag.
    const stack = state.undoStacks.get(modelId) ?? [];
    const last = stack.length > undoBefore ? stack[stack.length - 1] : undefined;
    const batchId = last ? state.mutationBatchTags.get(last.id) ?? null : null;
    remeshAfterCommit(get, modelId, batchId, [written.flightId ?? written.expressId], 'created');
  }
  return written;
}

/** Write a straight-run stair (and its flight) into `storeyId`; `params` are metres, storey-local. */
export function addStairIn(
  store: ModellingStore,
  modelId: string,
  storeyId: number,
  params: StairInStoreParams,
  options: StairRailingOptions = {},
): StairRailingOutcome {
  return write(store, modelId, storeyId, options, 'IFCSTAIR', (draft, anchor) => {
    const built = addStairToStore(draft, anchor, params);
    return { expressId: built.stairId, flightId: built.flightId };
  });
}

/** Write a railing along `params.Path` into `storeyId`; `params` are metres, storey-local. */
export function addRailingIn(
  store: ModellingStore,
  modelId: string,
  storeyId: number,
  params: RailingInStoreParams,
  options: StairRailingOptions = {},
): StairRailingOutcome {
  return write(store, modelId, storeyId, options, 'IFCRAILING', (draft, anchor) => ({
    expressId: addRailingToStore(draft, anchor, params).railingId,
  }));
}
