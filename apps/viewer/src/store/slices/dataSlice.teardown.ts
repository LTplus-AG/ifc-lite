/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `dataSlice`'s contribution to the store-wide teardown seam
 * (`store/teardown.ts`). Split out beside the slice for the reason
 * `modelSlice.teardown.ts` documents.
 *
 * `clearPendingColorUpdates` / `clearInstancedShards` / `resetMeshColors` stay
 * exactly as they are: they are the slice's own narrower actions with their own
 * callers and their own semantics (`resetMeshColors` RESTORES colours through
 * `pendingMeshColorUpdates` before clearing the backup, which is not what a
 * teardown wants).
 */

import { defineSliceTeardown } from '../teardown.js';

export const dataTeardown = defineSliceTeardown(
  'dataSlice',
  [
    'ifcDataStore',
    'geometryResult',
    'geometryUpdateTick',
    'pendingColorUpdates',
    'pendingMeshColorUpdates',
    'meshColorBackup',
    'pendingInstancedShards',
  ],
  {
    'session-reset': () => ({
      geometryUpdateTick: 0,
      // `null` here is a NO-OP at the renderer — `useGeometryStreaming`
      // returns early on a null `pendingColorUpdates`, so only a non-null
      // EMPTY map reaches `scene.clearColorOverrides()`. The actual release
      // of the outgoing model's clash/lens tint is
      // `endClashScenePresentation`'s empty Map, AFTER the set, in the entry
      // point. This write looks redundant and is not: it stops a queued
      // overlay from being uploaded into the new scene. Do not "improve" it
      // into an empty Map, and do not move the helper call.
      pendingColorUpdates: null,
      pendingMeshColorUpdates: null,
      // The backup those two restore FROM. Ids collide across models, so
      // surviving a swap made RESET_COLORS paint the old model's colours onto
      // the new one; first-write-wins made every later reset wrong too.
      meshColorBackup: null,
      // Drop any undrained GPU-instancing shards from the previous model so
      // they can't be uploaded into the new scene under a rapid model switch.
      pendingInstancedShards: null,
      // `ifcDataStore` / `geometryResult` are deliberately absent: a session
      // reset is a file LOAD, and the loader writes both straight after. They
      // follow the active model on the two federation arms below.
    }),
    'all-models-cleared': () => ({
      ifcDataStore: null,
      geometryResult: null,
      // Goes with the geometry it describes: first-write-wins, so a survivor
      // repaints a departed model's colour onto whatever takes that id next.
      // Unconditional here, unlike the scoped purge below:
      // `federationRegistry.clear()` restarts offsets at 0, so ids genuinely
      // ARE reused after this.
      meshColorBackup: null,
    }),
    'model-removed': (scope, state) => {
      const models = state.models;
      // Same guard as `modelSlice`'s arm: a removal that removes nothing writes
      // nothing, which is also what makes the second run (`syncSourceModel`
      // immediately after `removeModel`) a no-op.
      if (!models?.has(scope.modelId)) return {};

      // Follow the model that becomes active. The scope resolved it once, so
      // this and `modelSlice`'s `activeModelId` cannot name different models.
      const activeModel = scope.nextActiveModelId ? models.get(scope.nextActiveModelId) : null;

      return {
        ifcDataStore: activeModel?.ifcDataStore ?? null,
        geometryResult: activeModel?.geometryResult ?? null,
        meshColorBackup: purgeRemovedModelsBackup(scope.modelId, state),
      };
    },
  },
);

/**
 * Purge only THIS model's entries from the mesh-colour backup.
 *
 * Dropping the map whole would take the SURVIVING models' undo with it, and it
 * is not needed for them: `unregisterModel` BURNS the removed range rather than
 * reclaiming it, so no later model is handed these ids.
 *
 * NOT `scope.isStale`, deliberately, and this is the one place in the group
 * where the scope's predicate is the wrong question. `isStale` asks "does any
 * SURVIVOR own this id"; the backup asks "did the REMOVED model own it". The
 * two agree everywhere except on an id owned by no model at all — already
 * dangling before the removal — which this KEEPS and `isStale` would drop.
 * Keeping it is today's behaviour and this change is a restructuring, so the
 * owner-scoped resolver is what runs here.
 *
 * `resolveGlobalIdInModel` is the owner-scoped resolver `modelSlice` already
 * provides for exactly this question; it shares its range and overlay
 * predicates with the unscoped one, so the two cannot drift (#2697).
 *
 * It is NOT a pure function of the state handed in: it closes over the model
 * slice's own `get()` (`modelSlice.ts`, `mutationViewsOf(get())`), so it reads
 * the LIVE store. That is correct here for a reason, not by luck: every entry
 * point builds its patch BEFORE its own `set`, so live and snapshot are the
 * same models. An entry point that ever composed against a snapshot taken
 * before an intervening `set` would resolve `meshColorBackup` against
 * different data than every other contribution, with nothing to catch it.
 */
function purgeRemovedModelsBackup(
  modelId: string,
  state: {
    readonly meshColorBackup?: Map<number, [number, number, number, number]> | null;
    readonly resolveGlobalIdInModel?: (modelId: string, globalId: number) => unknown;
  },
): Map<number, [number, number, number, number]> | null | undefined {
  const prior = state.meshColorBackup;
  const resolveInModel = state.resolveGlobalIdInModel;
  // No backup, or a state without the resolver (a slice-scoped test harness):
  // hand back what was there rather than deciding on a predicate we don't have.
  if (!prior || !resolveInModel) return prior;

  const kept = new Map([...prior].filter(([id]) => resolveInModel(modelId, id) === null));
  // Nothing of the removed model's was in it — return the SAME map so the
  // composition drops the key instead of re-notifying on an equal copy.
  if (kept.size === prior.size) return prior;
  return kept.size > 0 ? kept : null;
}
