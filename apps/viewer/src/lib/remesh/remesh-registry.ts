/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which elements an undo batch re-shapes, so undo and redo re-mesh them
 * (#6232 WP1).
 *
 * A committed edit that changes geometry records its batch id here; undo or
 * redo of that batch (`replayHistory`) re-requests the same re-mesh once the
 * view is restored. Per store, keyed by the store's `get`, the same way
 * `mutation-inverse-registry.ts` keeps its viewer-only history metadata out
 * of the published mutation types. Bounded: the oldest entries go first, and
 * an entry for a batch that is no longer on any stack is simply never read.
 */

import type { ViewerState } from '@/store';
import { requestRemesh, type RemeshCause } from './remesh-service';

type Get = () => ViewerState;
interface Entry { modelId: string; expressIds: readonly number[]; cause: RemeshCause }

/** Past this many remembered batches, the oldest is forgotten. */
const MAX_ENTRIES = 1_000;
const byStore = new WeakMap<Get, Map<string, Entry>>();

function entries(get: Get): Map<string, Entry> {
  let map = byStore.get(get);
  if (!map) byStore.set(get, (map = new Map()));
  return map;
}

/** Remember that `batchId` re-shaped `expressIds` (model-local) of `modelId`. */
export function rememberRemesh(get: Get, batchId: string, modelId: string, expressIds: readonly number[], cause: RemeshCause): void {
  const map = entries(get);
  map.delete(batchId);
  map.set(batchId, { modelId, expressIds: [...expressIds], cause });
  if (map.size > MAX_ENTRIES) map.delete(map.keys().next().value!);
}

/**
 * Record a just-committed geometry edit and re-mesh it now: the one call an
 * authoring action makes after writing its batch. A null batch (nothing was
 * written) re-meshes nothing.
 */
export function remeshAfterCommit(
  get: Get, modelId: string, batchId: string | null, expressIds: readonly number[], cause: RemeshCause,
): void {
  if (batchId === null) return;
  rememberRemesh(get, batchId, modelId, expressIds, cause);
  void requestRemesh(get, modelId, expressIds, cause);
}

/** Re-mesh what `batchId` re-shaped, after undo or redo restored its view. */
export function remeshForBatch(get: Get, modelId: string, batchId: string | undefined): void {
  const entry = batchId === undefined ? undefined : entries(get).get(batchId);
  if (!entry || entry.modelId !== modelId) return;
  void requestRemesh(get, entry.modelId, entry.expressIds, entry.cause);
}
