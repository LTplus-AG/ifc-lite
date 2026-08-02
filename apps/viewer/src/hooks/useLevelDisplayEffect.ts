/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drive the Exploded level-display offsets, and keep the Solo mode flag honest.
 *
 * Stacked:
 *   - Subtract any previously-applied Exploded offsets so the renderer's mesh
 *     positions revert to their loaded values.
 *
 * Exploded:
 *   - Compute per-storey offsets via `computeStoreyOffsets` for each loaded
 *     model, diff against the per-model `appliedStoreyOffsets`, and push the
 *     deltas into `pendingMeshTranslations`. Stash the new applied offsets so
 *     the next toggle / gap change knows what to subtract.
 *
 * Solo:
 *   - NOT handled here. Solo == "this storey isolated", which is the existing
 *     `selectedStoreys` filter (resolved to globalIds by `computedIsolatedIds`
 *     in ViewportContainer). `applyLevelDisplayMode` sets that filter on entry
 *     and clears it on exit, so there is ONE isolation channel and it can never
 *     get stranded across a mode switch. Solo also carries no Exploded offsets,
 *     so the offset effect below reverts any lift when entering Solo.
 *
 * The second effect is a guard: if the storey isolation is cleared anywhere
 * else (hierarchy footer ×, Home / Show-all, Esc), drop the Solo flag back to
 * Stacked so the segmented control and the in-viewport chip stay truthful.
 */

import { useEffect } from 'react';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import {
  computeStoreyOffsets,
  diffStoreyOffsets,
  buildEntityTranslations,
  type StoreyOffsets,
} from '@/lib/level-offsets';

export function useLevelDisplayEffect(): void {
  const levelDisplayMode = useViewerStore((s) => s.levelDisplayMode);
  const explodedGap = useViewerStore((s) => s.explodedGap);
  const models = useViewerStore((s) => s.models);
  const appliedStoreyOffsets = useViewerStore((s) => s.appliedStoreyOffsets);
  const setAppliedStoreyOffsets = useViewerStore((s) => s.setAppliedStoreyOffsets);
  const setPendingMeshTranslations = useViewerStore((s) => s.setPendingMeshTranslations);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const setLevelDisplayMode = useViewerStore((s) => s.setLevelDisplayMode);

  useEffect(() => {
    // Compute the target Exploded offsets per model. `target` is empty unless
    // Exploded is active — diffing against the previously-applied offsets then
    // reverts any lift (covers Stacked and Solo).
    const target: typeof appliedStoreyOffsets = new Map();
    if (levelDisplayMode === 'exploded') {
      for (const [modelId, model] of models) {
        if (!model.ifcDataStore) continue;
        const offsets = computeStoreyOffsets(model.ifcDataStore, explodedGap);
        if (offsets.size > 0) target.set(modelId, offsets);
      }
    }

    // Build the renderer-frame translation map by diffing the target against
    // the slice's applied snapshot, per model. Sum into a single
    // Map<globalId, [dx,dy,dz]> so one push covers the whole scene.
    const aggregated = new Map<number, [number, number, number]>();
    const modelIds = new Set<string>([
      ...models.keys(),
      ...appliedStoreyOffsets.keys(),
    ]);
    for (const modelId of modelIds) {
      const targetMap: StoreyOffsets = target.get(modelId) ?? new Map();
      const previousMap: StoreyOffsets = appliedStoreyOffsets.get(modelId) ?? new Map();
      const diff = diffStoreyOffsets(targetMap, previousMap);
      if (diff.size === 0) continue;
      const dataStore = models.get(modelId)?.ifcDataStore;
      if (!dataStore) continue;
      const toGlobalId = (localExpressId: number): number =>
        toGlobalIdFromModels(models, modelId, localExpressId);
      const perEntity = buildEntityTranslations(dataStore, diff, toGlobalId);
      for (const [id, delta] of perEntity) {
        const existing = aggregated.get(id);
        if (existing) {
          aggregated.set(id, [existing[0] + delta[0], existing[1] + delta[1], existing[2] + delta[2]]);
        } else {
          aggregated.set(id, [delta[0], delta[1], delta[2]]);
        }
      }
    }
    if (aggregated.size > 0) {
      setPendingMeshTranslations(aggregated);
    }
    setAppliedStoreyOffsets(target);
    // appliedStoreyOffsets is intentionally NOT a dep — we write to it as a
    // side effect; depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelDisplayMode, explodedGap, models, setPendingMeshTranslations, setAppliedStoreyOffsets]);

  // Guard: Solo is "a storey isolated via selectedStoreys". If that isolation
  // is dropped from anywhere else, Solo is no longer active — fall back to
  // Stacked so the mode flag matches what's on screen.
  useEffect(() => {
    if (levelDisplayMode === 'solo' && selectedStoreys.size === 0) {
      setLevelDisplayMode('stacked');
    }
  }, [levelDisplayMode, selectedStoreys, setLevelDisplayMode]);
}
