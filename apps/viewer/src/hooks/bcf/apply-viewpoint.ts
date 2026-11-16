/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { BCFViewpoint } from '@ifc-lite/bcf';
import { extractViewpointState, viewpointFromWorld } from '@ifc-lite/bcf';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import type { EntityRef } from '@/store/types';
import { globalIdToExpressId as lookup } from '../bcfIdLookup';
import { resolveEntityRef } from '@/store/resolveEntityRef';
import { resolvePresentationIds } from '@/lib/presentation/resolvePresentationIds';
import { toast } from '@/components/ui/toast';
import { MAX_SECTION_PLANES } from '@/lib/section/section-plane-set';
import { clearSectionCut, showSectionCuts } from '@/store/section-active';
import { bcfWorldOffset, renderFrameBounds } from './viewpoint-world-frame';
import type { SectionRestoreSession } from './section-restore';
import { applyCameraState } from './apply-camera-state';
/** Native viewpoint transition shared by the panel and viewer operations. */
export function applyNativeBcfViewpoint(viewpoint: BCFViewpoint, renderer: Renderer | null, animate = true, sectionRestore?: SectionRestoreSession): void {
  const store = useViewerStore.getState(), models = store.models;
  const { setSelectedEntityId, setSelectedEntityIds, setSelectedEntity, addEntitiesToSelection, clearEntitySelection, setHiddenEntities, setIsolatedEntities } = store;
  const getBounds = () => renderFrameBounds(models);
  const getWorldOffset = () => bcfWorldOffset(models, store.geometryResult);
  const globalIdToExpressId = (guid: string) => lookup(guid, models, store.ifcDataStore);
  if (!renderer) {
    console.warn('[useBCF] Cannot apply viewpoint: no renderer');
    return;
  }

  const bounds = getBounds() ?? undefined;

  // Extract state from viewpoint (once, reused for camera, section plane, and selection)
  const state = extractViewpointState(
    viewpointFromWorld(viewpoint, getWorldOffset(), bounds), // world -> render frame (#4806)
    bounds,
    renderer.getCamera().getDistance() // Use current distance as reference
  );
  const { camera, sectionPlanes: viewpointSectionPlanes } = state;

  if (camera) {
    applyCameraState(renderer, camera, animate);
  }

  // A viewpoint with clipping planes shows its cut (opening the Section
  // tool — the renderer draws a cut nowhere else); one without clears any
  // cut, parked ones included, so the view matches the topic (#4910).
  sectionRestore?.noteBeforeViewpoint(useViewerStore.getState());
  const cuts = viewpointSectionPlanes?.filter((plane) => plane.enabled) ?? [];
  if (cuts.length > MAX_SECTION_PLANES) {
    console.warn(`[useBCF] The viewpoint has ${cuts.length} clipping planes; showing the first ${MAX_SECTION_PLANES}.`);
    toast.info(`This viewpoint has ${cuts.length} clipping planes; the first ${MAX_SECTION_PLANES} are shown.`);
  }
  if (cuts.length > 0) {
    showSectionCuts(useViewerStore.getState, cuts.slice(0, MAX_SECTION_PLANES));
  } else {
    clearSectionCut(useViewerStore.getState);
  }
  sectionRestore?.noteAfterViewpoint(useViewerStore.getState());

  // Apply selection from BCF components. A federated viewpoint can select
  // elements across several models, so drive BOTH selection channels:
  // `selectedEntityIds` (global ids) for the renderer highlight, and the
  // model-aware `selectedEntitiesSet` (local {modelId, expressId} refs) for
  // property/federation context. (#1591: previously this collapsed to the
  // first element, losing every other selection and all model context.)
  if (state.selectedGuids.length > 0) {
    const globalIds: number[] = []; // renderer highlight (federated global ids)
    const refs: EntityRef[] = []; // model-aware multi-selection
    for (const guid of state.selectedGuids) {
      const result = globalIdToExpressId(guid);
      if (!result) continue;
      // result.expressId is already the federation-offset global id.
      globalIds.push(result.expressId);
      // Reverse the offset with the SAME store `models` map the forward
      // mapping used, not the renderer singleton, so refs can never desync
      // from globalIds if the registry lags the store.
      const localRef = resolveEntityRef(result.expressId);
      if (localRef) refs.push(localRef);
    }

    if (globalIds.length > 0) {
      // Reset both channels, then apply the full multi-model selection.
      clearEntitySelection();
      setSelectedEntityIds(globalIds);
      if (refs.length > 0) addEntitiesToSelection(refs);
      // Pin the primary selection to the first element for consistent
      // property display / framing (both channels keep the full set).
      setSelectedEntityId(globalIds[0]);
      if (refs.length > 0) setSelectedEntity(refs[0]);
    }
  } else {
    // Clear selection if viewpoint has no selection
    clearEntitySelection();
  }

  // Apply visibility from BCF components: isolation mode (visibleGuids
  // with defaultVisibility=false) or normal (hiddenGuids, default true).
  // `state.visibleGuids` is meaningfully nullable (`extractViewpointState`,
  // packages/bcf/src/viewpoint.ts): `null` means the viewpoint carries no
  // isolation channel, while a non-null array -- EMPTY included -- means
  // isolation WAS active when the viewpoint was captured, down to
  // "matched nothing". A `.length > 0` check here would read a captured
  // empty viewport (a real, spec-valid `DefaultVisibility="false"` with
  // no exceptions) as "no isolation" and fall into the `hiddenGuids`
  // branch below, restoring an unfiltered view instead of an empty one --
  // the read-side mirror of the same collapse fixed on the write side
  // above and in `createViewpoint`'s `hasVisible`.
  if (state.visibleGuids !== null) {
    // Isolation mode: only specified entities are visible
    const isolatedExpressIds = new Set<number>();
    for (const guid of state.visibleGuids) {
      const result = globalIdToExpressId(guid);
      if (result) isolatedExpressIds.add(result.expressId);
    }

    if (state.visibleGuids.length > 0 && isolatedExpressIds.size === 0) {
      // THIRD state. The viewpoint names elements, and NONE of them is in
      // the model currently loaded -- the ordinary case for a BCF file
      // authored against a different (or differently versioned) model.
      // That is not "isolation matched nothing": the isolation could not
      // be evaluated here at all. Applying it as an empty isolate would
      // hide every element of a model the viewpoint never spoke about,
      // which is indistinguishable from a broken viewer. Leave the
      // isolation channel off and say why, so the camera and selection
      // the viewpoint DOES carry still land on a visible model.
      setIsolatedEntities(null);
      toast.info(
        "Viewpoint visibility not applied: none of its elements are in the loaded model."
      );
    } else {
      // #3338: a viewpoint guid may name a geometry-less assembly whose parts carry the mesh.
      const resolver = useViewerStore.getState().cameraCallbacks.resolveHighlightIds;
      setIsolatedEntities(new Set(resolvePresentationIds(resolver, [...isolatedExpressIds])));
    }
  } else if (state.hiddenGuids.length > 0) {
    // Normal mode: specified entities are hidden
    const hiddenExpressIds = new Set<number>();
    for (const guid of state.hiddenGuids) {
      const result = globalIdToExpressId(guid);
      if (result) {
        hiddenExpressIds.add(result.expressId);
      }
    }

    if (hiddenExpressIds.size > 0) {
      setHiddenEntities(hiddenExpressIds);
    }
  } else {
    // Clear all visibility state if viewpoint has none
    setHiddenEntities(new Set());
  }
}
