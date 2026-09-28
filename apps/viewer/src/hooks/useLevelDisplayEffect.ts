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
 *   - Compute current per-storey and per-entity target offsets for each loaded
 *     model, diff against the last applied per-entity offsets, and push the
 *     deltas into `pendingMeshTranslations`. This also catches membership edits
 *     while the Exploded gap stays unchanged.
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
  buildEntityLevelOffsets,
  diffEntityLevelOffsets,
  type StoreyOffsets,
} from '@/lib/level-offsets';
import { effectiveLevelElevations } from '@/lib/effective-level-elevations';
import { effectiveScheduleGroups } from '@/lib/effective-spatial-groups';
import type { AppliedEntityLevelOffsets } from '@/store/slices/levelDisplaySlice';
import type { FederatedModel } from '@/store/types';

function modelGeometryRefs(model: FederatedModel): Map<number, object> {
  const refs = new Map<number, object>();
  for (const mesh of model.geometryResult?.meshes ?? []) {
    // Use the first piece: appending another piece must not make us translate
    // the already-lifted pieces a second time as though all were replaced.
    if (!refs.has(mesh.expressId)) refs.set(mesh.expressId, mesh);
  }
  const instancedIndex = model.geometryResult?.instancedGeometryHashes;
  if (instancedIndex) for (const id of instancedIndex.keys()) {
    if (!refs.has(id)) refs.set(id, instancedIndex);
  }
  return refs;
}

function sameStoreyOffsets(a: ReadonlyMap<string, StoreyOffsets>, b: ReadonlyMap<string, StoreyOffsets>): boolean {
  if (a.size !== b.size) return false;
  for (const [modelId, offsets] of a) {
    const other = b.get(modelId);
    if (!other || other.size !== offsets.size) return false;
    for (const [storey, offset] of offsets) if (other.get(storey) !== offset) return false;
  }
  return true;
}

function sameEntityOffsets(a: AppliedEntityLevelOffsets, b: AppliedEntityLevelOffsets): boolean {
  if (a.size !== b.size) return false;
  for (const [modelId, entry] of a) {
    const other = b.get(modelId);
    if (!other || other.store !== entry.store || other.offsets.size !== entry.offsets.size) return false;
    for (const [id, offset] of entry.offsets) {
      if (other.offsets.get(id) !== offset || other.geometryRefs.get(id) !== entry.geometryRefs.get(id)) return false;
    }
  }
  return true;
}

export function useLevelDisplayEffect(): void {
  const levelDisplayMode = useViewerStore((s) => s.levelDisplayMode);
  const explodedGap = useViewerStore((s) => s.explodedGap);
  const models = useViewerStore((s) => s.models);
  const mutationViews = useViewerStore((s) => s.mutationViews);
  const mutationVersion = useViewerStore((s) => s.mutationVersion);
  const appliedStoreyOffsets = useViewerStore((s) => s.appliedStoreyOffsets);
  const appliedEntityLevelOffsets = useViewerStore((s) => s.appliedEntityLevelOffsets);
  const setAppliedStoreyOffsets = useViewerStore((s) => s.setAppliedStoreyOffsets);
  const setAppliedEntityLevelOffsets = useViewerStore((s) => s.setAppliedEntityLevelOffsets);
  const setPendingMeshTranslations = useViewerStore((s) => s.setPendingMeshTranslations);
  const selectedStoreys = useViewerStore((s) => s.selectedStoreys);
  const setLevelDisplayMode = useViewerStore((s) => s.setLevelDisplayMode);

  useEffect(() => {
    // Compute the target Exploded offsets per model. `target` is empty unless
    // Exploded is active — diffing against the previously-applied offsets then
    // reverts any lift (covers Stacked and Solo).
    const target: typeof appliedStoreyOffsets = new Map();
    const targetEntities: AppliedEntityLevelOffsets = new Map();
    const geometryRefsByModel = new Map<string, Map<number, object>>();
    if (levelDisplayMode === 'exploded' || appliedEntityLevelOffsets.size > 0) {
      for (const [modelId, model] of models) geometryRefsByModel.set(modelId, modelGeometryRefs(model));
    }
    if (levelDisplayMode === 'exploded') {
      for (const [modelId, model] of models) {
        const dataStore = model.ifcDataStore;
        if (!dataStore) continue;
        const view = mutationViews.get(modelId);
        const members = view?.hasPendingChanges()
          ? effectiveScheduleGroups(dataStore, view, 'IfcBuildingStorey', { includeSpatialNodes: true }) : undefined;
        const elevations = members && view ? effectiveLevelElevations(dataStore, view, members.keys()) : undefined;
        const offsets = computeStoreyOffsets(dataStore, explodedGap, elevations);
        if (offsets.size > 0) target.set(modelId, offsets);
        const toGlobalId = (localExpressId: number): number =>
          toGlobalIdFromModels(models, modelId, localExpressId);
        const entityOffsets = buildEntityLevelOffsets(dataStore, offsets, toGlobalId, members);
        // A relationship may be authored before its mesh has arrived. The
        // renderer drops translations for absent IDs when it drains the map,
        // so only record a lift once the model publishes that entity's mesh.
        const geometryRefs = geometryRefsByModel.get(modelId)!;
        for (const id of entityOffsets.keys()) if (!geometryRefs.has(id)) entityOffsets.delete(id);
        if (entityOffsets.size > 0) targetEntities.set(modelId, { store: dataStore, offsets: entityOffsets, geometryRefs });
      }
    }

    // Diff per entity: moving a product between storeys changes its target Y
    // even when neither storey's offset changed. A new store instance starts
    // from native geometry, so an old instance's applied offsets are ignored.
    const aggregated = new Map<number, [number, number, number]>();
    for (const [modelId, model] of models) {
      if (!model.ifcDataStore) continue;
      const previous = appliedEntityLevelOffsets.get(modelId);
      const nextEntry = targetEntities.get(modelId);
      const previousOffsets = new Map<number, number>();
      if (previous?.store === model.ifcDataStore) for (const [id, offset] of previous.offsets) {
        // A replacement mesh starts at native coordinates even if its old
        // counterpart carried an Exploded lift. Reapply the full target.
        if (previous.geometryRefs.get(id) === geometryRefsByModel.get(modelId)?.get(id)) {
          previousOffsets.set(id, offset);
        }
      }
      const nextOffsets = nextEntry?.offsets ?? new Map<number, number>();
      for (const [id, delta] of diffEntityLevelOffsets(nextOffsets, previousOffsets)) {
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
    // Write only a changed snapshot: `models` also changes on every geometry
    // update, and a fresh empty Map each time is a store notification (#6232).
    if (!sameStoreyOffsets(target, appliedStoreyOffsets)) setAppliedStoreyOffsets(target);
    if (!sameEntityOffsets(targetEntities, appliedEntityLevelOffsets)) setAppliedEntityLevelOffsets(targetEntities);
    // Applied offsets are intentionally not deps: the effect writes those
    // snapshots itself. The mutation revision does belong here, since views
    // are mutable and can retain their identity across edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelDisplayMode, explodedGap, models, mutationViews, mutationVersion,
    setPendingMeshTranslations, setAppliedStoreyOffsets, setAppliedEntityLevelOffsets]);

  // Guard: Solo is "a storey isolated via selectedStoreys". If that isolation
  // is dropped from anywhere else, Solo is no longer active — fall back to
  // Stacked so the mode flag matches what's on screen.
  useEffect(() => {
    if (levelDisplayMode === 'solo' && selectedStoreys.size === 0) {
      setLevelDisplayMode('stacked');
    }
  }, [levelDisplayMode, selectedStoreys, setLevelDisplayMode]);
}
