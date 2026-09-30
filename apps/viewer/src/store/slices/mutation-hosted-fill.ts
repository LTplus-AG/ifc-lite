/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hosted openings, doors and windows (charter #6232, A1): the one write path
 * behind the Model workspace's `opening.place` / `door.place` /
 * `window.place` commands, the inspector's Hosting edits, and the SDK's
 * `bim.store.addOpening` / `addHostedDoor` / `addHostedWindow`.
 *
 * An opening or filling is a compound graph (the opening, IfcRelVoidsElement,
 * and for a door or window the filling, IfcRelFillsElement and its
 * containment, plus their placements and shapes). `bim.store`'s modelling
 * methods write it through `recordModellingEdit`, which runs them atomically
 * and puts every record they wrote on the undo stack, so one Ctrl+Z removes
 * the whole graph, and in a shared room publishes it.
 *
 * The host is then re-meshed with the new element (#6391): it comes back with
 * the true void cut, and the door or window gets its real mesh. Inside a
 * modeling transaction (`batchId` given) the transaction does that for the
 * whole commit; on its own the action does it, for undo and redo too.
 */

import {
  editHostedElementInStore,
  readHostedFill,
  type HostedElementEdit,
  type HostedElementInStoreSpec,
} from '@ifc-lite/create';
import type { ViewerState } from '../index.js';
import { mutationDenial } from '../mutation-permission.js';
import { registerAuthoredElement } from '@/utils/spatialHierarchy.js';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from './mutation-modelling-records.js';

export type HostedFillSpec = HostedElementInStoreSpec;

export type HostedFillKind = HostedFillSpec['kind'];

export type HostedFillOutcome =
  | { readonly expressId: number; readonly openingId: number; readonly hostId: number }
  | { readonly error: string };

export interface HostedFillOptions {
  /** The modeling transaction's batch: it tags and re-meshes the commit, so the action does neither. */
  readonly batchId?: string;
}

const FILL_TYPE: Readonly<Record<'door' | 'window', string>> = { door: 'IFCDOOR', window: 'IFCWINDOW' };

/** Why a model cannot take hosted elements at all (D2: IFC5 / IFCX models are refused), or null. */
export function hostedFillRefusal(state: ViewerState, modelId: string): string | null {
  const dataStore = state.models.get(modelId)?.ifcDataStore;
  if (!dataStore) return `No model loaded for id "${modelId}"`;
  const schema = String(dataStore.schemaVersion ?? 'IFC4').toUpperCase();
  if (schema === 'IFC5' || !dataStore.source || dataStore.source.byteLength === 0) {
    return 'Openings, doors and windows are authored in IFC2X3, IFC4 and IFC4X3 models only';
  }
  return null;
}

export function addHostedFillIn(
  store: ModellingStore,
  modelId: string,
  hostExpressId: number,
  spec: HostedFillSpec,
  options: HostedFillOptions = {},
): HostedFillOutcome {
  const get = store.getState;
  const refusal = mutationDenial(get(), modelId) ?? hostedFillRefusal(get(), modelId);
  if (refusal) return { error: refusal };
  const undoBefore = get().undoStacks.get(modelId)?.length ?? 0;
  let expressId: number;
  try {
    expressId = recordModellingEdit(store, modelId, (methods) => {
      if (spec.kind === 'door') return methods.addHostedDoor(modelId, hostExpressId, spec.params).expressId;
      if (spec.kind === 'window') return methods.addHostedWindow(modelId, hostExpressId, spec.params).expressId;
      return methods.addOpening(modelId, hostExpressId, spec.params).expressId;
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const state = get();
  const target = modelEditTarget(state, modelId);
  const read = target ? readHostedFill(target.dataStore, expressId, target.view) : null;
  const openingId = read?.openingId ?? expressId;
  // A door or window is contained in its host's storey: list it there in the spatial tree.
  const hierarchy = target?.dataStore.spatialHierarchy;
  const storeyId = hierarchy?.elementToStorey.get(hostExpressId);
  if (spec.kind !== 'opening' && hierarchy && storeyId !== undefined) {
    const name = target?.view.getNewEntity(expressId)?.attributes?.[2];
    registerAuthoredElement(hierarchy, storeyId, expressId, FILL_TYPE[spec.kind], typeof name === 'string' ? name : '');
  }

  if (options.batchId === undefined) {
    // The batch `recordModellingEdit` just recorded: its last mutation's tag.
    const stack = state.undoStacks.get(modelId) ?? [];
    const last = stack.length > undoBefore ? stack[stack.length - 1] : undefined;
    const batchId = last ? state.mutationBatchTags.get(last.id) ?? null : null;
    remeshAfterCommit(get, modelId, batchId, [expressId, hostExpressId], 'created');
  }
  return { expressId, openingId, hostId: hostExpressId };
}

export interface HostedFillPosition {
  /** Metres along the host from its placement origin. */
  readonly offset?: number;
  /** Metres above the host's placement origin. */
  readonly sill?: number;
}

export type HostedFillMoveOutcome =
  | { readonly ok: true; readonly remesh: readonly number[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Move a hosted opening (or the door or window in one) along its host and
 * up or down: one write to the opening's Location, which the filling is
 * placed relative to. The positional write lands on the undo stack; the
 * caller's transaction tags it and re-meshes what it returns.
 */
export function moveHostedFillIn(store: ModellingStore, modelId: string, expressId: number, position: HostedFillPosition): HostedFillMoveOutcome {
  return editHostedFillIn(store, modelId, expressId, { Offset: position.offset, Sill: position.sill });
}

/** Thin history adapter for the shared hosted params-to-commit core. The
 * outer command transaction tags these records and re-meshes the real cut. */
export function editHostedFillIn(store: ModellingStore, modelId: string, expressId: number, patch: HostedElementEdit): HostedFillMoveOutcome {
  const refusal = mutationDenial(store.getState(), modelId) ?? hostedFillRefusal(store.getState(), modelId);
  if (refusal) return { ok: false, reason: refusal };
  const target = modelEditTarget(store.getState(), modelId);
  if (!target) return { ok: false, reason: `No model loaded for id "${modelId}"` };
  try {
    const read = recordModellingEdit(store, modelId, (_methods, draft) => editHostedElementInStore(target.dataStore, draft, expressId, patch));
    return { ok: true, remesh: [read.openingId, ...(read.fillingId === null ? [] : [read.fillingId]), read.hostId] };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
