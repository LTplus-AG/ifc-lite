/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Geometry restore pending" for one model (user decision 2026-11-14: a
 * reopened model is interactive once its stored scene is shown and its metadata
 * is ready; picking, selection, measuring and section caps wait for the
 * geometry restore).
 *
 * A cache hit that adopted a stored scene publishes the metadata store early,
 * right after the metadata decode (tree, properties and search work from here),
 * and marks the model pending until that load ends (`settleOwnedLoadUi`, every
 * end: completed, failed or cancelled). A superseded primary removes the model
 * in the next load's reset, which ends the hold with it.
 *
 * The single gate is `isGeometryHeld` (lib/pick-gating.ts): true while any
 * model is pending. A backstop ends a hold that outlives `RESTORE_BACKSTOP_MS`
 * and COUNTS it (`geometryRestoreBackstopFires`, plus a console warning): a
 * fire means a load end that never released its model, i.e. a bug.
 */

import type { LoadTrace } from '@ifc-lite/load-trace';
import type { IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';

export const RESTORE_BACKSTOP_MS = 60_000;

const backstops = new Map<string, ReturnType<typeof setTimeout>>();
const delayedReleases = new Map<string, ReturnType<typeof setTimeout>>();
let backstopFires = 0;

type GeometryRestoreTestHook = { releaseDelayMs?: number; backstopFires?: number; geometryRestoreBackstopFires?: () => number };
function testHook(): GeometryRestoreTestHook | undefined {
  return (globalThis as typeof globalThis & { __ifc_lite_geometry_restore_test__?: GeometryRestoreTestHook }).__ifc_lite_geometry_restore_test__;
}

/** How many holds the backstop had to end (tests; non-zero in a session means a missed release). */
export function geometryRestoreBackstopFires(): number { return backstopFires; }

function setPending(modelId: string, pending: boolean): void {
  const state = useViewerStore.getState();
  const model = state.models.get(modelId);
  if (!model || Boolean(model.geometryRestorePending) === pending) return;
  state.updateModel(modelId, { geometryRestorePending: pending });
}

export function beginGeometryRestore(modelId: string): void {
  const delayed = delayedReleases.get(modelId);
  if (delayed !== undefined) { clearTimeout(delayed); delayedReleases.delete(modelId); }
  endGeometryRestore(modelId);
  setPending(modelId, true);
  backstops.set(modelId, setTimeout(() => {
    backstops.delete(modelId);
    // A model that is gone or already released is not a stuck hold.
    if (!useViewerStore.getState().models.get(modelId)?.geometryRestorePending) return;
    backstopFires += 1;
    if (testHook()) testHook()!.backstopFires = backstopFires;
    console.warn(`[geometry-restore-gate] backstop released model ${modelId} after ${RESTORE_BACKSTOP_MS} ms: its load end never released it`);
    setPending(modelId, false);
  }, RESTORE_BACKSTOP_MS));
}

/** Idempotent; called at every load end for its model. */
export function endGeometryRestore(modelId: string): void {
  const timer = backstops.get(modelId);
  if (timer !== undefined) { clearTimeout(timer); backstops.delete(modelId); }
  const delay = testHook()?.releaseDelayMs;
  if (delay && delay > 0 && useViewerStore.getState().models.get(modelId)?.geometryRestorePending) {
    const previous = delayedReleases.get(modelId);
    if (previous !== undefined) clearTimeout(previous);
    delayedReleases.set(modelId, setTimeout(() => {
      delayedReleases.delete(modelId);
      setPending(modelId, false);
    }, delay));
    return;
  }
  const delayed = delayedReleases.get(modelId);
  if (delayed !== undefined) { clearTimeout(delayed); delayedReleases.delete(modelId); }
  setPending(modelId, false);
}

/**
 * The early publication of a cache hit that adopted its stored scene: the
 * metadata store goes out now, the model is held until its geometry is
 * restored, and `load.metadataInteractive` marks the moment the stored scene is
 * shown AND the metadata is published (the reopen lanes' interactive mark).
 */
export function publishMetadataAtMark(
  modelId: string,
  dataStore: IfcDataStore,
  sceneShown: Promise<void>, // the adopted snapshot's first-visible promise: the mark waits for a real scene-show event
  trace: LoadTrace,
  isStale?: () => boolean,
): true {
  beginGeometryRestore(modelId);
  trace.span('cache.publishStore', () => useViewerStore.getState().setIfcDataStore(dataStore));
  // A load cancelled or superseded before its scene is shown reports no interactive reopen.
  void sceneShown.then(() => { if (!isStale?.()) trace.milestone('load.metadataInteractive'); });
  return true;
}
