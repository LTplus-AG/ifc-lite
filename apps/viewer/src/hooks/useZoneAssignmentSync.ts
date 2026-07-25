/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Orchestrates zone assignment (issue #1810 v1): gathers a world-space AABB
 * for every element across EVERY loaded model (mirrors `useClash` owning
 * clash's gather-and-run step while `clashSlice` only holds state), runs
 * the pure `assignElementsToZoneSets` engine, and writes the result into
 * `zonesSlice`.
 *
 * Recomputes when:
 *  - the federation's model set changes (a model was added/removed) —
 *    `models` gets a fresh Map reference on every mutation
 *    (`modelSlice.ts`), so referential inequality is exactly "federation
 *    changed";
 *  - `geometryUpdateTick` bumps — geometry for a model can finish uploading
 *    to the `Scene` AFTER the model entry itself appears (streamed/async
 *    load), so relying on `models` alone would compute against incomplete
 *    bounding boxes;
 *  - `zoneSets` changes — any zone create/edit/delete/move.
 *
 * Debounced by `RECOMPUTE_DEBOUNCE_MS` so a burst of geometry ticks during a
 * big streamed load coalesces into one recompute instead of one per tick.
 * Mount once near the viewport root (`ZoneAssignmentSync` below), same
 * lifetime as the renderer.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import { getGlobalRenderer } from './useBCF.js';
import { assignElementsToZoneSets, type ElementAABB } from '../lib/zones/index.js';

const RECOMPUTE_DEBOUNCE_MS = 200;

/** Gather a world-space AABB for every entity the renderer's `Scene` has
 *  mesh data for — this already includes every loaded model (the scene is
 *  shared across federation) and already folds `MeshData.origin` (see
 *  `Scene.getEntityBoundingBox`), so no separate per-model AABB folding is
 *  needed here. */
function gatherElementBounds(): ElementAABB[] {
  const renderer = getGlobalRenderer();
  const scene = renderer?.getScene();
  if (!scene) return [];
  const elements: ElementAABB[] = [];
  for (const globalId of scene.getAllMeshDataExpressIds()) {
    const bbox = scene.getEntityBoundingBox(globalId);
    if (!bbox) continue;
    elements.push({
      globalId,
      min: [bbox.min.x, bbox.min.y, bbox.min.z],
      max: [bbox.max.x, bbox.max.y, bbox.max.z],
    });
  }
  return elements;
}

/** Run the assignment engine once, synchronously, and write the result +
 *  timing into the store. Exported for tests / manual re-trigger (e.g. a
 * "recompute now" button); `useZoneAssignmentSync` is the auto-recompute
 * wiring. */
export function recomputeZoneAssignmentsNow(): void {
  const state = useViewerStore.getState();
  if (state.zoneSets.length === 0) {
    if (state.zoneAssignments.size > 0 || state.zoneAssignmentTiming !== null) {
      state.setZoneAssignments(new Map(), { elapsedMs: 0, elementCount: 0, zoneSetCount: 0, computedAt: Date.now() });
    }
    return;
  }
  const elements = gatherElementBounds();
  const t0 = performance.now();
  const assignments = assignElementsToZoneSets(elements, state.zoneSets);
  const elapsedMs = performance.now() - t0;
  state.setZoneAssignments(assignments, {
    elapsedMs,
    elementCount: elements.length,
    zoneSetCount: state.zoneSets.length,
    computedAt: Date.now(),
  });
}

/** Mount once (e.g. in `ViewportContainer`) to keep `zoneAssignments` live
 *  as models load/unload and zones are authored. Renders nothing. */
export function useZoneAssignmentSync(): void {
  const models = useViewerStore((s) => s.models);
  const geometryUpdateTick = useViewerStore((s) => s.geometryUpdateTick);
  const zoneSets = useViewerStore((s) => s.zoneSets);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      recomputeZoneAssignmentsNow();
    }, RECOMPUTE_DEBOUNCE_MS);
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, geometryUpdateTick, zoneSets]);
}
