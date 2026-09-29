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
  placedBodyExtent,
  readHostedFill,
  resolveHostAnchor,
  toNativeLength,
  type HostedDoorInStoreParams,
  type HostedWindowInStoreParams,
  type OpeningInStoreParams,
} from '@ifc-lite/create';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ViewerState } from '../index.js';
import { mutationDenial } from '../mutation-permission.js';
import { registerAuthoredElement } from '@/utils/spatialHierarchy.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale.js';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';
import { modelEditTarget, recordModellingEdit, type ModellingStore } from './mutation-modelling-records.js';

export type HostedFillSpec =
  | { readonly kind: 'opening'; readonly params: OpeningInStoreParams }
  | { readonly kind: 'door'; readonly params: HostedDoorInStoreParams }
  | { readonly kind: 'window'; readonly params: HostedWindowInStoreParams };

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
export function moveHostedFillIn(get: () => ViewerState, modelId: string, expressId: number, position: HostedFillPosition): HostedFillMoveOutcome {
  for (const value of [position.offset, position.sill]) {
    if (value !== undefined && !Number.isFinite(value)) return { ok: false, reason: 'Offset and sill must be numbers' };
  }
  const target = modelEditTarget(get(), modelId);
  const read = target ? readHostedFill(target.dataStore, expressId, target.view) : null;
  if (!target || !read) return { ok: false, reason: `#${expressId} is not an opening placed in its host` };
  const unit = { lengthUnitScale: getModelLengthUnitScale(target.dataStore) };
  const [x, y, z] = read.location;
  const next: [number, number, number] = [
    position.offset === undefined ? x : toNativeLength(unit, position.offset),
    y,
    position.sill === undefined ? z : toNativeLength(unit, position.sill),
  ];
  // The same fit rule the placing commands apply before a commit.
  const misfit = hostMisfit(target.dataStore, target.view, read.hostId, read.openingId, read.location, next);
  if (misfit) return { ok: false, reason: misfit };
  if (next[0] !== x || next[2] !== z) get().setPositionalAttributesBatch(modelId, [{ entityId: read.locationPointId, index: 0, value: next }]);
  return { ok: true, remesh: [read.openingId, ...(read.fillingId === null ? [] : [read.fillingId]), read.hostId] };
}

/** Tolerance on the fit check: a value exactly at the wall's edge fits. */
const FIT_EPS = 1e-6;

/**
 * Why the opening, moved so its Location is `location` (native units, the
 * host's frame), stays inside the host's body along the wall and up it. The
 * opening's own body is measured in the host's frame (`placedBodyExtent`), so
 * an opening of any profile or orientation, authored here or by another tool,
 * is held to its real extent. An opening or host whose body cannot be read is
 * refused rather than moved unchecked. Null when it fits.
 */
function hostMisfit(dataStore: IfcDataStore, view: MutablePropertyView, hostId: number, openingId: number, from: readonly number[], location: readonly number[]): string | null {
  let host;
  try {
    host = resolveHostAnchor(dataStore, hostId, view).hostBounds;
  } catch (error) {
    console.warn(`[modeling] host #${hostId} of opening #${openingId} is unreadable; its move is refused`, error);
    return `The host #${hostId} can't be read, so the move is refused`;
  }
  const cut = placedBodyExtent(dataStore, openingId, view);
  if (!host || !cut) return `The size of opening #${openingId} or its host #${hostId} can't be read, so the move is refused`;
  const dx = location[0] - from[0], dz = location[2] - from[2];
  const fits = cut.min[0] + dx >= host.min[0] - FIT_EPS && cut.max[0] + dx <= host.max[0] + FIT_EPS
    && cut.min[2] + dz >= host.min[2] - FIT_EPS && cut.max[2] + dz <= host.max[2] + FIT_EPS;
  return fits ? null : "It doesn't fit in this wall: change its offset or sill";
}
