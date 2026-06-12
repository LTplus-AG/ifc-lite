/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Level-display transitions — the ONE place that maps Stacked / Exploded /
 * Solo onto state, so every entry point (the storey-tab control, the command
 * palette, the in-viewport chip, a hierarchy storey click) behaves identically.
 *
 * Solo and "isolate this storey" are the same thing, so they share ONE channel:
 * the storey isolation filter (`selectedStoreys`). Solo isolates the active (or
 * top) storey through it; switching to Stacked / Exploded clears it — so the
 * isolation can never get stranded when the mode changes. (Previously Solo used
 * a second `isolatedEntities` channel that mode switches didn't clear, leaving
 * the model stuck isolated.)
 */

import { useViewerStore } from './index.js';
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

/**
 * Apply a level-display mode through the single unified storey-isolation
 * channel.
 *
 * - `solo`  : focus + isolate one storey (the passed ref, else the active
 *             storey, else the top storey). Sets `activeStorey` +
 *             `selectedStoreys` so the hierarchy row highlights and the
 *             renderer isolates via the existing `computedIsolatedIds` path.
 * - others  : clear the storey isolation so Stacked / Exploded show every
 *             storey (Exploded then lifts them apart via the offset effect).
 */
export function applyLevelDisplayMode(mode: LevelDisplayMode, soloRef?: EntityRef | null): void {
  const s = useViewerStore.getState();
  if (mode === 'solo') {
    const ref = soloRef ?? s.activeStorey ?? pickTopStorey();
    if (!ref) return; // nothing to solo (no storeys) — leave the mode unchanged
    s.setActiveStorey(ref);
    s.setStoreysSelection([ref.expressId]);
    s.setLevelDisplayMode('solo');
  } else {
    s.clearStoreySelection();
    s.setLevelDisplayMode(mode);
  }
}
