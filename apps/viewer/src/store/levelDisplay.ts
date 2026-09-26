/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Level-display transitions — the ONE place that maps Stacked / Exploded /
 * Solo onto state, so every entry point (the storey-tab control, the command
 * palette, the in-viewport chip, a hierarchy storey action) behaves identically.
 *
 * Solo and "isolate this storey" are the same thing, so they share ONE channel:
 * the storey isolation filter (`selectedStoreys`). Solo isolates the active (or
 * top) storey through it; switching to Stacked / Exploded clears it — so the
 * isolation can never get stranded when the mode changes. (Previously Solo used
 * a second `isolatedEntities` channel that mode switches didn't clear, leaving
 * the model stuck isolated.)
 */

import { useViewerStore } from './index.js';
import { toGlobalIdFromModels } from './globalId.js';
import type { EntityRef } from './types.js';
import type { LevelDisplayMode } from './slices/levelDisplaySlice.js';

type ElevationCarrier = { spatialHierarchy?: { storeyElevations?: Map<number, number> } | null } | null | undefined;

/** Highest-elevation storey across loaded models (model-aware). Used as the
 *  Solo default when nothing is focused — the top storey, not the empty
 *  basement the old cold-start landed on. */
export function pickTopStorey(): EntityRef | null {
  const s = useViewerStore.getState();
  let bestRef: EntityRef | null = null;
  let bestElev = -Infinity;
  const consider = (modelId: string, ds: ElevationCarrier) => {
    const elevs = ds?.spatialHierarchy?.storeyElevations;
    if (!elevs) return;
    for (const [id, elev] of elevs) {
      if (elev > bestElev) {
        bestElev = elev;
        bestRef = { modelId, expressId: id };
      }
    }
  };
  if (s.models.size > 0) {
    for (const [modelId, model] of s.models) consider(modelId, model.ifcDataStore as ElevationCarrier);
  } else {
    consider('legacy', s.ifcDataStore as ElevationCarrier);
  }
  return bestRef;
}

/** True when the storey ref still resolves to a loaded model + storey. Guards
 *  against a stale `activeStorey` left over after a model is removed or the
 *  viewer is reset for a new file. */
function storeyExists(ref: EntityRef): boolean {
  const s = useViewerStore.getState();
  const ds = (ref.modelId === 'legacy' ? s.ifcDataStore : s.models.get(ref.modelId)?.ifcDataStore) as ElevationCarrier;
  const elevs = ds?.spatialHierarchy?.storeyElevations;
  return !!elevs && elevs.has(ref.expressId);
}

/**
 * Apply a level-display mode through the single unified storey-isolation
 * channel.
 *
 * - `solo`  : focus + isolate the passed storeys (one logical unified level
 *             can contain contributions from several models), else the active
 *             storey, else the top storey. Sets `activeStorey` +
 *             `selectedStoreys` so the renderer isolates every contribution
 *             via the existing `computedIsolatedIds` path.
 * - others  : clear the storey isolation so Stacked / Exploded show every
 *             storey (Exploded then lifts them apart via the offset effect).
 */
export function applyLevelDisplayMode(mode: LevelDisplayMode, soloRefs?: readonly EntityRef[]): void {
  const s = useViewerStore.getState();
  if (mode === 'solo') {
    // A unified storey has one ref per model. Keep every loaded contribution;
    // stale refs after a model removal are ignored. With no valid explicit
    // target, fall back to the active or highest storey as before.
    const requested = soloRefs?.length ? soloRefs : s.activeStorey ? [s.activeStorey] : [];
    const refs = requested.filter(storeyExists);
    if (refs.length === 0) {
      const fallback = pickTopStorey();
      if (fallback) refs.push(fallback);
    }
    if (refs.length === 0) return; // nothing to solo (no storeys) — leave the mode unchanged
    s.setActiveStorey(refs[0]);
    s.setStoreysSelection(refs.map((ref) => toGlobalIdFromModels(s.models, ref.modelId, ref.expressId)));
    s.setLevelDisplayMode('solo');
  } else {
    s.clearStoreySelection();
    s.setLevelDisplayMode(mode);
  }
}
