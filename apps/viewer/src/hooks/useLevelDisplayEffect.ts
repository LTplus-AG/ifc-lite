/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drive Exploded / Solo level display modes from the slice state.
 *
 * Stacked:
 *   - Subtract any previously-applied Exploded offsets so the
 *     renderer's mesh positions revert to their loaded values.
 *   - Clear isolation if we're coming out of Solo.
 *
 * Exploded:
 *   - Compute per-storey offsets via `computeStoreyOffsets` for
 *     each loaded model.
 *   - Diff against the per-model `appliedStoreyOffsets` and push
 *     the deltas into `pendingMeshTranslations` so the renderer
 *     applies them on the next frame.
 *   - Stash the new applied offsets on the slice so the next
 *     toggle / gap change knows what to subtract.
 *
 * Solo:
 *   - Use the existing `setIsolatedEntities` channel to gate
 *     visibility to the chosen storey's entities (resolved to
 *     federation global ids).
 *
 * The hook reads from a slim selector (`useViewerStore`) and only
 * runs its work when `levelDisplayMode`, `explodedGap`, or the
 * set of loaded models changes. No per-frame work.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import {
  computeStoreyOffsets,
  diffStoreyOffsets,
  buildEntityTranslations,
  entitiesInStorey,
  type StoreyOffsets,
} from '@/lib/level-offsets';

export function useLevelDisplayEffect(): void {
  const levelDisplayMode = useViewerStore((s) => s.levelDisplayMode);
  const explodedGap = useViewerStore((s) => s.explodedGap);
  const soloStoreyExpressId = useViewerStore((s) => s.soloStoreyExpressId);
  const models = useViewerStore((s) => s.models);
  const activeModelId = useViewerStore((s) => s.activeModelId);
  const appliedStoreyOffsets = useViewerStore((s) => s.appliedStoreyOffsets);
  const setAppliedStoreyOffsets = useViewerStore((s) => s.setAppliedStoreyOffsets);
  const setPendingMeshTranslations = useViewerStore((s) => s.setPendingMeshTranslations);
  const setIsolatedEntities = useViewerStore((s) => s.setIsolatedEntities);

  // Track the last-applied mode so the cleanup logic can tell
  // "user is exiting Exploded" from "user is changing gap inside
  // Exploded". Without this, the diff math handles both, but
  // having a discrete flag makes it cheap to skip Solo→Solo
  // re-entry without touching translations.
  const lastModeRef = useRef(levelDisplayMode);

  useEffect(() => {
    // Compute the target Exploded offsets per model. `target` is
    // empty when Exploded isn't active — diff against the
    // previously-applied offsets will revert any lifts.
    const target: typeof appliedStoreyOffsets = new Map();
    if (levelDisplayMode === 'exploded') {
      for (const [modelId, model] of models) {
        if (!model.ifcDataStore) continue;
        const offsets = computeStoreyOffsets(model.ifcDataStore, explodedGap);
        if (offsets.size > 0) target.set(modelId, offsets);
      }
    }

    // Build the renderer-frame translation map by diffing the
    // target against the slice's applied snapshot, per model. Sum
    // into a single Map<globalId, [dx,dy,dz]> so one push covers
    // the whole scene.
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

    // Solo isolation. The previous-mode tracking keeps Solo →
    // Solo (storey change) from re-touching isolation when
    // nothing actually changed.
    if (levelDisplayMode === 'solo') {
      // Resolve which storey we're isolating. Slice default is
      // null → pick the first storey of the active model.
      let storeyId = soloStoreyExpressId;
      const fallbackModelId = activeModelId ?? models.keys().next().value ?? null;
      const fallbackStore = fallbackModelId ? models.get(fallbackModelId)?.ifcDataStore : undefined;
      if (storeyId === null && fallbackStore) {
        const elevations = fallbackStore.spatialHierarchy?.storeyElevations;
        if (elevations && elevations.size > 0) {
          // Lowest-elevation storey by default — predictable
          // behaviour vs map-iteration order.
          storeyId = [...elevations.entries()].sort((a, b) => a[1] - b[1])[0][0];
        }
      }
      if (storeyId !== null && fallbackModelId) {
        const toGlobalId = (localExpressId: number): number =>
          toGlobalIdFromModels(models, fallbackModelId, localExpressId);
        const ids = entitiesInStorey(fallbackStore ?? undefined, storeyId, toGlobalId);
        setIsolatedEntities(new Set(ids));
      } else {
        setIsolatedEntities(null);
      }
    } else if (lastModeRef.current === 'solo') {
      // Leaving Solo → drop isolation. (User may have manually
      // re-isolated via the basket; we still clear because the
      // Solo cleanup should be predictable. Tradeoff documented.)
      setIsolatedEntities(null);
    }

    lastModeRef.current = levelDisplayMode;
    // appliedStoreyOffsets is intentionally NOT a dep — we write
    // to it as a side effect; depending on it would loop. The
    // ref-based last-mode check covers the Solo→other case.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    levelDisplayMode,
    explodedGap,
    soloStoreyExpressId,
    models,
    activeModelId,
    setPendingMeshTranslations,
    setIsolatedEntities,
    setAppliedStoreyOffsets,
  ]);
}
