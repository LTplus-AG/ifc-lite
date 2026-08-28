/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Apply the entity-scoped embed URL parameters (`?select=`, `?isolate=`) once
 * the first model is on screen.
 *
 * `urlParams.ts` has parsed these since the embed shipped and nothing ever
 * read them (#2934): the parser is thoroughly tested, the application of the
 * parsed value did not exist. `?hideTypes=` and `?camera=` are applied at
 * their own actuators in `EmbedViewer.tsx` (the geometry filter and the
 * camera-callback poll respectively) rather than here.
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

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import type { EmbedViewerUrlParams } from '../bridge/urlParams.js';

/**
 * Normalise `?hideTypes=` names into a lookup set.
 *
 * Case-folded on purpose. `mesh.ifcType` is PascalCase (`IfcSpace`), while the
 * embed SDK's own documented example passes SCREAMING_CASE (`IFCSPACE`, the
 * spelling STEP files use). A raw string comparison would match neither the
 * SDK's example nor a host page typing `ifcspace`, and would hide nothing
 * while reporting no error. Returns `null` when there is nothing to hide, so
 * the caller can skip the filter entirely.
 */
export function toHiddenTypeSet(names: string[] | undefined): Set<string> | null {
  if (!names || names.length === 0) return null;
  const set = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length > 0) set.add(trimmed.toLowerCase());
  }
  return set.size > 0 ? set : null;
}

/** True when `ifcType` is named by a `toHiddenTypeSet` result. */
export function isTypeHidden(ifcType: string | undefined, hidden: Set<string> | null): boolean {
  if (!hidden || !ifcType) return false;
  return hidden.has(ifcType.toLowerCase());
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
      // uses (`bridge/handler.ts`) before assigning -- falls back to the raw
      // ids when no renderer has registered a resolver yet.
      const resolved = state.cameraCallbacks.resolveHighlightIds?.(urlParams.isolate) ?? urlParams.isolate;
      state.setIsolatedEntities(new Set(resolved));
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
