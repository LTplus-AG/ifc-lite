/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Apply the entity-scoped embed URL parameters (`?select=`, `?isolate=`) once
 * the first model is on screen.
 *
 * `urlParams.ts` has parsed these since the embed shipped and nothing ever
 * read them (#2934): the parser is thoroughly tested, the application of the
 * parsed value did not exist. `?camera=` is applied at its own actuator in
 * `EmbedViewer.tsx` (the camera-callback poll) rather than here;
 * `?hideTypes=` is normalised by `useHostHiddenIfcTypes` below and applied at
 * two actuators, the mesh filter in `useModelViewGeometry.ts` and the store
 * field the symbolic 2D overlay reads.
 *
 * Two things this hook is deliberate about:
 *
 *  - It waits for geometry. Both parameters name entity ids in a model that is
 *    still being fetched at mount, and `loadFile` resets selection as part of
 *    ingesting a model — applying them earlier writes state that the load then
 *    throws away.
 *  - It applies them exactly ONCE, guarded by a ref rather than by the
 *    dependency array. `isolateEntities` (visibilitySlice) is a same-set
 *    TOGGLE — a second call with identical ids CLEARS isolation — so an effect
 *    that re-ran would undo itself. `setIsolatedEntities` is used instead of
 *    `isolateEntities` for the same reason: it assigns, so it cannot toggle.
 *  - `?isolate=` ids are routed through `cameraCallbacks.resolveHighlightIds`
 *    before being assigned (#3338), same as the embed bridge's ISOLATE
 *    command (`bridge/handler.ts`) -- a raw geometry-less assembly id would
 *    otherwise blank the viewport (#2531/#2532's failure mode, reachable
 *    here too since this hook was the one channel `check-isolate-expansion-
 *    routing.mjs`'s literal-token match could not see: it calls the
 *    ASSIGNING `setIsolatedEntities`, never `isolateEntities`).
 */

import { useEffect, useMemo, useRef } from 'react';
import { resolveIsolationIds } from '@/lib/isolation/resolveIsolationIds.js';
import { useViewerStore } from '@/store';
import { toHostHiddenIfcTypes } from '@/lib/host-hidden-ifc-types.js';
import type { EmbedViewerUrlParams } from '../bridge/urlParams.js';

/**
 * The host's `hideTypes` list, normalised, and PUBLISHED to the viewer store.
 *
 * Two consumers need it and they are nowhere near each other. The mesh filter
 * in `useModelViewGeometry` takes the returned set directly. The symbolic 2D
 * overlay cannot: it is not a mesh, so no filter over the mesh list reaches it
 * (#2934, `lib/symbolic-overlay-gate.ts`), and the hooks that build it sit two
 * levels below `Viewport`. They read `store.hostHiddenIfcTypes`, which is what
 * this writes — the route `?controls=` already takes below, and one that needs
 * no prop threaded through a component no test mounts, because mounting it
 * needs a WebGPU device.
 *
 * The folding itself is `apps/viewer`'s (`toHostHiddenIfcTypes`), because both
 * consumers must agree on it and one of them lives there.
 */
export function useHostHiddenIfcTypes(names: string[] | undefined): ReadonlySet<string> | null {
  const hidden = useMemo(() => toHostHiddenIfcTypes(names), [names]);
  const setHostHiddenIfcTypes = useViewerStore((s) => s.setHostHiddenIfcTypes);
  useEffect(() => {
    setHostHiddenIfcTypes(hidden);
  }, [hidden, setHostHiddenIfcTypes]);
  return hidden;
}

/**
 * `modelReady` must be true for BOTH load paths, which is easy to get wrong
 * because only one of them writes `geometryResult`.
 *
 * Every `setGeometryResult` in the loader sits under `target.kind ===
 * 'primary'`, and the federation hook carries an explicit "Do NOT call
 * setGeometryResult() here!" -- federated geometry arrives through the models
 * map instead. So deriving readiness from `geometryResult` alone leaves a host
 * that mounts the iframe with `?select=` and no `modelUrl`, then calls
 * `addModel()`, with meshes on screen and a selection that silently never
 * applies. Callers pass `geometryResult?.meshes?.length || storeModels.size`.
 *
 * `?hideTypes=` is unaffected either way: it filters `mergedGeometryResult`,
 * which already reads the models map.
 */
export function useEmbedUrlParams(urlParams: EmbedViewerUrlParams, modelReady: boolean): void {
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current || !modelReady) return;
    if (!urlParams.select && !urlParams.isolate) return;
    applied.current = true;

    const state = useViewerStore.getState();
    if (urlParams.select) state.setSelectedEntityIds(urlParams.select);
    if (urlParams.isolate) {
      // #3338: a `?isolate=` id can name a geometry-less IfcElementAssembly
      // (or any other container the renderer never draws a mesh for), which
      // would blank the viewport exactly like the LensPanel/PropertiesPanel
      // /SearchModal/embed-bridge ISOLATE regressions this issue tracks.
      // Route through the same resolver the embed bridge's ISOLATE command
      // uses (`bridge/handler.ts`) before assigning -- the raw ids are kept
      // when no renderer has registered a resolver yet, or when it resolves
      // to nothing.
      const isolateIds = resolveIsolationIds(state.cameraCallbacks.resolveHighlightIds, urlParams.isolate);
      state.setIsolatedEntities(new Set(isolateIds));
    }
  }, [modelReady, urlParams.select, urlParams.isolate]);

  // `?controls=` (#2934) names no entity, so unlike select/isolate above it
  // does not wait for a model: `setInteractionMode` itself defers to the
  // renderer via `pendingInteractionMode` (cameraSlice) if `Viewport` hasn't
  // registered its callbacks yet, so applying it once on mount is enough.
  const controlsApplied = useRef(false);
  useEffect(() => {
    if (controlsApplied.current || !urlParams.controls) return;
    controlsApplied.current = true;
    useViewerStore.getState().setInteractionMode(urlParams.controls);
  }, [urlParams.controls]);
}
