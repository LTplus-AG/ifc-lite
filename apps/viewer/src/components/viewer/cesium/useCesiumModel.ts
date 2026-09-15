/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The world view's model lifecycle: build the GLB, load it into Cesium, swap it
 * in without a visible gap, and keep its matrix current.
 *
 * Split out of CesiumOverlay.tsx (#2593), which had grown past 1,000 lines
 * carrying four unrelated responsibilities. This is the one with the most
 * history behind it — #2558 (the GLB must hold the whole model, instanced
 * occurrences included), #2578 (it must hide what the viewport hides), #2583
 * (the old model stays until its replacement can actually draw) — so it is the
 * one that most benefits from being readable on its own.
 *
 * ORDERING NOTE: call this hook where its effects sat — after the bridge hook,
 * before the solar hook. Within a component React runs effect setups in
 * declaration order AND cleanups in that same order (verified, not assumed:
 * "cleanups run in reverse" is a common misreading that only describes
 * child-before-parent across the tree). So the viewer effect, declared first,
 * cleans up FIRST — which is why nothing in this hook's cleanup may touch the
 * viewer. It only cancels the in-flight build; removing the primitive is left
 * to the not-ready branch, or to the viewer teardown itself via `invalidate`.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useViewerStore } from '@/store';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { VisibilityEpochTracker } from '@ifc-lite/renderer';
import { effectiveIsolatedIds } from '@/lib/effective-isolation';
import { ghostExemptSelection } from '@/lib/ghost-selection';
import { cesiumPlacementKey } from '@/lib/geo/cesium-model-glb';
import type { CesiumBridge } from '@/lib/geo/cesium-bridge';
import { getCesiumModule } from './cesium-module';
import type { CesiumModelPrimitive } from './cesium-model-renderable';
import type { CesiumViewerLifetime } from './cesium-viewer-lifetime';
import {
  buildCesiumModelMatrix,
  loadCesiumModel,
  type CesiumModelGlbCache,
} from './cesium-model-load';
export { buildCesiumModelMatrix } from './cesium-model-load';

export interface UseCesiumModelParams {
  /** Viewer readiness, owned by the viewer effect. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Bumped when the coordinate bridge is rebuilt. */
  bridgeVersion: number;
  viewerRef: RefObject<InstanceType<typeof import('cesium').Viewer> | null>;
  /** Retired synchronously before the Viewer destroys its collections (#4807). */
  viewerLifetimeRef: RefObject<CesiumViewerLifetime | null>;
  bridgeRef: RefObject<CesiumBridge | null>;
  geometryResult?: GeometryResult | null;
  coordinateInfo?: CoordinateInfo;
  mapConversion?: MapConversion;
  projectedCRS?: ProjectedCRS;
  lengthUnitScale?: number;
  /** Storey, class-filter and manual isolation intersected, as the viewport
   *  receives it. */
  computedIsolatedIds?: ReadonlySet<number> | null;
}

export interface UseCesiumModelResult {
  /** The primitive currently on the globe, for consumers that style it. */
  modelRef: RefObject<CesiumModelPrimitive | null>;
  /** Changes whenever a DIFFERENT primitive reaches the globe. */
  modelEpoch: number;
  /**
   * Forget the model WITHOUT removing it — for the viewer teardown, which
   * destroys the whole scene and takes the primitive with it. This is the one
   * path this hook's own not-ready branch cannot cover: on unmount React runs
   * cleanups but does not re-run effects, so without this the store flag would
   * keep advertising a model that is gone.
   */
  invalidate: () => void;
}

/** @see {@link UseCesiumModelParams} for the ordering contract. */
export function useCesiumModel({
  status,
  bridgeVersion,
  viewerRef,
  viewerLifetimeRef,
  bridgeRef,
  geometryResult,
  coordinateInfo,
  mapConversion,
  projectedCRS,
  lengthUnitScale = 1,
  computedIsolatedIds,
}: UseCesiumModelParams): UseCesiumModelResult {
  const setCesiumGlbLoaded = useViewerStore((s) => s.setCesiumGlbLoaded);
  // In-place mesh mutations (a gizmo move rewrites positions in the SAME
  // arrays) change no mesh count, so the world-view GLB cache keys on this too.
  const geometryContentVersion = useViewerStore((s) => s.geometryContentVersion);
  const placement = useViewerStore((s) => s.modelPlacement);
  const placementKey = useMemo(() => cesiumPlacementKey(placement), [placement]);
  // Hide/isolate, resolved the way Viewport resolves what it hands the
  // renderer, so the map draws the elements the viewport draws (#2578).
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const storeIsolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const isolatedEntities = effectiveIsolatedIds(computedIsolatedIds, storeIsolatedEntities);
  // X-Ray context (#2591). Everything NOT in this set fades; selection is
  // exempt, matching the renderer — which exempts BOTH the scalar selection and
  // the multi-select set (`index.ts` folds `selectedId` into `selectedIds`), so
  // a single click must count too.
  const ghostExceptEntities = useViewerStore((s) => s.ghostExceptEntities);
  const selectedEntityId = useViewerStore((s) => s.selectedEntityId);
  const selectedEntityIds = useViewerStore((s) => s.selectedEntityIds);
  // The GLB effect keys on this version, NOT on the Set references. The store
  // hands out a fresh Set on every visibility action, and the effect's cleanup
  // pulls the model off the globe — so keying on identity blanks the map for a
  // second and rebuilds a multi-megabyte GLB even when the content is
  // unchanged. `VisibilityEpochTracker` compares content, so an equal set is a
  // no-op while an in-place mutation of the same Set still registers.
  //
  // Safe to run during render: `update()` only bumps when the content actually
  // changed, so a double-invoked render (StrictMode) returns the same version.
  const visibilityEpochsRef = useRef(new VisibilityEpochTracker());
  const visibilityVersion = visibilityEpochsRef.current.update(hiddenEntities, isolatedEntities);
  // Selection only matters while X-Ray is on, because that is the only time it
  // changes a byte of the GLB. Tracking it unconditionally would rebuild a
  // multi-megabyte model on every Ctrl-click in ordinary viewing.
  const ghosting = ghostExceptEntities != null;
  const selectionForGhost = useMemo(
    () => (ghosting ? ghostExemptSelection(selectedEntityId, selectedEntityIds) : null),
    [ghosting, selectedEntityIds, selectedEntityId],
  );

  // A second content-based epoch for the X-Ray set, for the same reason as the
  // first: a fresh Set with equal content must not rebuild a multi-megabyte GLB.
  //
  // Argument ORDER matters. The tracker collapses an empty first argument to
  // null and preserves an empty second one — so the ghost set goes second,
  // where "except nothing" (ghost everything) stays distinguishable from null
  // (no X-Ray at all). Selection goes first, where empty and null are the same
  // thing, which for a selection they are.
  const ghostEpochsRef = useRef(new VisibilityEpochTracker());
  const ghostVersion = ghostEpochsRef.current.update(selectionForGhost, ghostExceptEntities);
  // Read inside the deferred build, which runs long after the effect fired.
  const visibilityRef = useRef({
    hiddenIds: hiddenEntities,
    isolatedIds: isolatedEntities,
    ghostExceptIds: ghostExceptEntities,
    selectedIds: selectionForGhost,
  });
  visibilityRef.current = {
    hiddenIds: hiddenEntities,
    isolatedIds: isolatedEntities,
    ghostExceptIds: ghostExceptEntities,
    selectedIds: selectionForGhost,
  };

  // Track the Cesium model (IFC geometry loaded as glTF for correct world positioning)
  const cesiumModelRef = useRef<CesiumModelPrimitive | null>(null);
  const glbCacheRef = useRef<CesiumModelGlbCache>(null);
  // Key of the model actually ON the globe, which is not the same thing as the
  // key of the last GLB built — see the gate in the load effect.
  const loadedKeyRef = useRef<string | null>(null);
  // Bumped every time a NEW model primitive reaches the globe. `cesiumGlbLoaded`
  // used to serve this purpose by flipping false->true around every rebuild, but
  // the model now stays loaded across one (#2583), so the flag no longer moves.
  const [cesiumModelEpoch, setCesiumModelEpoch] = useState(0);

  // ─── Effect 2c: Load GLB into Cesium (only when geometry changes) ───────
  // This is the heavy operation — only re-runs when geometry actually changes.
  useEffect(() => {
    if (status !== 'ready' || !geometryResult?.meshes?.length) {
      // The model must not outlive its geometry. The effect cleanup no longer
      // evicts it (#2583), so a session that unloads its model, or a viewer
      // that leaves 'ready', is torn down here instead.
      const live = viewerRef.current;
      const lifetime = viewerLifetimeRef.current;
      if (cesiumModelRef.current && live && lifetime?.isLive(live)) {
        live.scene.primitives.remove(cesiumModelRef.current);
        live.scene.requestRender();
      }
      cesiumModelRef.current = null;
      loadedKeyRef.current = null;
      setCesiumGlbLoaded(false);
      return;
    }
    const viewer = viewerRef.current;
    const lifetime = viewerLifetimeRef.current;
    const bridge = bridgeRef.current;
    const Cesium = getCesiumModule();
    if (!viewer || !lifetime?.isLive(viewer) || !bridge || !Cesium) return;

    let cancelled = false;
    const superseded = () => cancelled || !lifetime.isLive(viewer)
      || cesiumPlacementKey(useViewerStore.getState().modelPlacement) !== placementKey;

    const startExport = () => {
      void loadCesiumModel({
        Cesium, viewer, lifetime, bridge, coordinateInfo, glbCacheRef,
        modelRef: cesiumModelRef, loadedKey: loadedKeyRef.current, isSuperseded: superseded,
        glbInput: { geometryResult, geometryContentVersion, placementKey,
          hiddenIds: visibilityRef.current.hiddenIds, isolatedIds: visibilityRef.current.isolatedIds,
          visibilityVersion, ghostExceptIds: visibilityRef.current.ghostExceptIds,
          selectedIds: visibilityRef.current.selectedIds, ghostVersion },
        onInstalled: (_model, key) => {
          loadedKeyRef.current = key;
          setCesiumGlbLoaded(true);
          setCesiumModelEpoch((epoch) => epoch + 1);
        },
      });
    };

    const deferTimer = setTimeout(startExport, 1000);
    const stopOnViewerRetire = lifetime.onRetire(() => { cancelled = true; });

    // Cancel the in-flight build only. Evicting the live model here is what
    // blanked the map on every re-run (#2583); the model is exchanged for its
    // replacement once that replacement exists, and torn down by the
    // no-geometry branch above or with the viewer in Effect 1.
    return () => {
      cancelled = true;
      clearTimeout(deferTimer);
      stopOnViewerRetire();
    };
  }, [status, bridgeVersion, geometryResult, geometryContentVersion, placementKey, visibilityVersion, ghostVersion]);

  // ─── Effect 2d: Update model matrix (instant, no reload) ────────────────
  // When terrain placement or georef changes, just update the
  // existing model's matrix — no GLB re-export, no flicker.
  useEffect(() => {
    const model = cesiumModelRef.current;
    const bridge = bridgeRef.current;
    const viewer = viewerRef.current;
    const lifetime = viewerLifetimeRef.current;
    const Cesium = getCesiumModule();
    if (!model || !bridge || !viewer || !lifetime?.isLive(viewer) || !Cesium) return;

    const newMatrix = buildCesiumModelMatrix(Cesium, bridge, coordinateInfo);
    model.modelMatrix = newMatrix;
    viewer.scene.requestRender();
    // Depend on bridgeVersion so the matrix is rebuilt with the *new* bridge
    // after async createCesiumBridge replaces it. Placement is baked into
    // bridge.modelOrigin.height by Effect 2.
  }, [mapConversion, projectedCRS, coordinateInfo, lengthUnitScale, bridgeVersion]);

  const invalidate = useCallback(() => {
    cesiumModelRef.current = null;
    loadedKeyRef.current = null;
    setCesiumGlbLoaded(false);
  }, [setCesiumGlbLoaded]);

  return { modelRef: cesiumModelRef, modelEpoch: cesiumModelEpoch, invalidate };
}
