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
 * ORDERING NOTE: the caller must invoke this hook in the position the effects
 * occupied, between the bridge effect and the solar effect. React runs effects
 * in declaration order and cleanups in reverse, and the teardown here assumes
 * the viewer effect's cleanup runs after its own.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { useViewerStore } from '@/store';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { VisibilityEpochTracker } from '@ifc-lite/renderer';
import { effectiveIsolatedIds } from '@/lib/effective-isolation';
import { buildCesiumModelGLB, cesiumModelGLBKey, type CesiumModelGLBInput } from '@/lib/geo/cesium-model-glb';
import { swapCesiumModel } from '@/lib/geo/cesium-model-swap';
import type { CesiumBridge } from '@/lib/geo/cesium-bridge';
import { getCesiumModule } from './cesium-module';

/**
 * Build a Cesium model matrix for placing the IFC model in ECEF.
 * Extracted as a pure function so it can be called from both
 * the GLB load effect (initial) and the matrix update effect (instant).
 */
function buildModelMatrix(
  Cesium: typeof import('cesium'),
  bridge: CesiumBridge,
  coordinateInfo: CoordinateInfo | undefined,
) {
  // GLB vertices are in viewer-space metres (geometry engine converts during
  // extraction; the effective map scale is already folded into the rotation).
  const bounds = coordinateInfo?.originalBounds;
  // Viewer bounds are already in metres (geometry engine converts from IFC native unit)
  const mvx = bounds ? (bounds.min.x + bounds.max.x) / 2 : 0;
  const mvy = bounds ? (bounds.min.y + bounds.max.y) / 2 : 0;
  const mvz = bounds ? (bounds.min.z + bounds.max.z) / 2 : 0;

  // bridge.modelOrigin.height is the placement altitude — Effect 2 already
  // baked terrain clamping (when applicable) into it before constructing the
  // bridge, so there's no per-frame clamp adjustment to make here.
  const origin = Cesium.Cartesian3.fromDegrees(
    bridge.modelOrigin.longitude, bridge.modelOrigin.latitude, bridge.modelOrigin.height,
  );
  const enuToEcef = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  // No lengthUnitScale here: viewer-space GLB vertices are already in metres.
  // Reuse the bridge's convergence-corrected viewer-to-ENU rotation so the
  // model geometry and the camera frame agree on north; a grid-only rotation
  // here would leave the model rotated by the meridian convergence off the
  // true-north basemap (up to ~8 deg for Krovak). See #1408.
  const rot = bridge.viewerRotation;
  const tx = -(rot.eastFromVx * mvx + rot.eastFromVz * mvz);
  const ty = -(rot.northFromVx * mvx + rot.northFromVz * mvz);
  const tz = -mvy;
  const ifcToEnu = new Cesium.Matrix4(
    rot.eastFromVx,  0, rot.eastFromVz,  tx,
    rot.northFromVx, 0, rot.northFromVz, ty,
    0,               1, 0,               tz,
    0,               0, 0,               1,
  );
  return Cesium.Matrix4.multiply(enuToEcef, ifcToEnu, new Cesium.Matrix4());
}

/** The slice of `Cesium.Model` this overlay touches. */
type CesiumModelPrimitive = {
  modelMatrix: any;
  shadows?: any;
  ready?: boolean;
  readyEvent?: { addEventListener(cb: () => void): () => void };
  destroy?: () => void;
};

/**
 * Resolves once `model` can actually draw.
 *
 * `Model.fromGltfAsync` resolving only means the glTF was fetched and parsed:
 * Cesium finishes creating WebGL resources inside `update()` over subsequent
 * frames, raises `readyEvent` from `frameState.afterRender`, and then skips one
 * more frame before rendering. Waiting for the event plus a rendered frame is
 * what makes "swap without a visible gap" true rather than merely
 * "swap without an empty collection" (#2583).
 *
 * Rejects if neither happens within the timeout, so a model that never becomes
 * renderable cannot strand its predecessor on the globe for the session.
 */
function whenModelRenderable(
  viewer: { scene: { postRender: { addEventListener(cb: () => void): () => void } }; },
  model: CesiumModelPrimitive,
  timeoutMs = 5_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      offReady?.();
      offFrame?.();
      globalThis.clearTimeout(timer);
      if (ok) { resolve(); return; }
      // Bounded on purpose: the timeout path degrades to exactly the old
      // behaviour (drop the previous model and accept a brief blank), so a
      // model that is merely slow costs a flicker, not a stranded primitive.
      console.warn('[CesiumOverlay] model did not report renderable within %d ms; swapping anyway', timeoutMs);
      reject(new Error('model never became renderable'));
    };
    // One rendered frame AFTER ready — Cesium deliberately returns early from
    // the update that raises the event, so the model draws on the next one.
    const afterReady = () => { offFrame = viewer.scene.postRender.addEventListener(() => finish(true)); };
    let offFrame: (() => void) | undefined;
    let offReady: (() => void) | undefined;
    const timer = globalThis.setTimeout(() => finish(false), timeoutMs);
    if (model.ready) { afterReady(); return; }
    if (!model.readyEvent) { finish(true); return; } // nothing to wait on
    offReady = model.readyEvent.addEventListener(() => { offReady?.(); afterReady(); });
  });
}

export interface UseCesiumModelParams {
  /** Viewer readiness, owned by the viewer effect. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Bumped when the coordinate bridge is rebuilt. */
  bridgeVersion: number;
  viewerRef: RefObject<InstanceType<typeof import('cesium').Viewer> | null>;
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
  // Hide/isolate, resolved the way Viewport resolves what it hands the
  // renderer, so the map draws the elements the viewport draws (#2578).
  const hiddenEntities = useViewerStore((s) => s.hiddenEntities);
  const storeIsolatedEntities = useViewerStore((s) => s.isolatedEntities);
  const isolatedEntities = effectiveIsolatedIds(computedIsolatedIds, storeIsolatedEntities);
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
  // Read inside the deferred build, which runs long after the effect fired.
  const visibilityRef = useRef({ hiddenIds: hiddenEntities, isolatedIds: isolatedEntities });
  visibilityRef.current = { hiddenIds: hiddenEntities, isolatedIds: isolatedEntities };

  // Track the Cesium model (IFC geometry loaded as glTF for correct world positioning)
  const cesiumModelRef = useRef<CesiumModelPrimitive | null>(null);
  const glbCacheRef = useRef<{ key: string; glb: Uint8Array } | null>(null);
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
      if (cesiumModelRef.current && live) {
        live.scene.primitives.remove(cesiumModelRef.current);
        live.scene.requestRender();
      }
      cesiumModelRef.current = null;
      loadedKeyRef.current = null;
      setCesiumGlbLoaded(false);
      return;
    }
    const viewer = viewerRef.current;
    const bridge = bridgeRef.current;
    const Cesium = getCesiumModule();
    if (!viewer || !bridge || !Cesium) return;

    let cancelled = false;

    const startExport = async () => {
      if (cancelled) return;
      // Declared at this scope so the catch can release a model that was built
      // but never installed (the viewer was destroyed mid-load).
      let model: CesiumModelPrimitive | null = null;
      try {
        // Reuse the cached GLB when it was built from the same mesh set. The key
        // spans flat AND instanced geometry (see cesiumModelGLBKey), so an
        // all-instanced batch still invalidates it.
        const glbInput: CesiumModelGLBInput = {
          geometryResult,
          geometryContentVersion,
          hiddenIds: visibilityRef.current.hiddenIds,
          isolatedIds: visibilityRef.current.isolatedIds,
          visibilityVersion,
        };
        const key = cesiumModelGLBKey(glbInput);
        const cached = glbCacheRef.current;
        // Gate on what is ON THE GLOBE, not on what has been BUILT. The two
        // diverge whenever a load is cancelled or `fromGltfAsync` rejects: the
        // bytes cache already holds the new key while the old primitive is
        // still displayed, and gating on the byte cache would then treat the
        // stale model as current and never retry the load.
        if (cesiumModelRef.current && loadedKeyRef.current === key) {
          // Model already loaded with same geometry — just update matrix
          return;
        }

        // The previous model deliberately stays on the globe while its
        // replacement is built and loaded — `swapCesiumModel` exchanges them
        // at the end, so the map never goes blank mid-rebuild (#2583).
        let glbBytes: Uint8Array;
        if (cached?.key === key) {
          glbBytes = cached.glb;
        } else {
          await new Promise(r => setTimeout(r, 50));
          if (cancelled) return;
          const built = buildCesiumModelGLB(glbInput);
          glbBytes = built.glb;
          glbCacheRef.current = { key: built.key, glb: built.glb };
        }
        if (cancelled) return;

        await new Promise(r => setTimeout(r, 0));
        if (cancelled) return;

        // Build initial model matrix
        const modelMatrix = buildModelMatrix(Cesium, bridge, coordinateInfo);

        const blob = new Blob([glbBytes as BlobPart], { type: 'model/gltf-binary' });
        const glbUrl = URL.createObjectURL(blob);
        try {
          model = await Cesium.Model.fromGltfAsync({
            url: glbUrl,
            modelMatrix,
            shadows: Cesium.ShadowMode.DISABLED,
            // The generated GLB stores viewer-space vertices and buildModelMatrix
            // already maps viewer axes into ENU. Avoid Cesium's default glTF
            // Y-up/Z-forward correction or the model is rotated onto its side.
            upAxis: Cesium.Axis.Z,
            forwardAxis: Cesium.Axis.X,
          });
          // Ambient floor. The overlay composits transparently with the
          // atmosphere/skybox off, so the scene's ONLY light is the directional
          // sun — without an environment map the model's shadowed faces get no
          // ambient and read muddy. Give the model a flat image-based-lighting
          // ambient via a constant spherical-harmonic term: every surface stays
          // readable while the sun still shapes the lit faces. (#1380)
          try {
            const ibl = (model as unknown as {
              imageBasedLighting?: { sphericalHarmonicCoefficients: unknown };
            }).imageBasedLighting;
            if (ibl) {
              const a = new Cesium.Cartesian3(0.72, 0.72, 0.75); // neutral daylight ambient
              const z = Cesium.Cartesian3.ZERO;
              ibl.sphericalHarmonicCoefficients = [a, z, z, z, z, z, z, z, z];
            }
          } catch (e) {
            console.warn('[CesiumOverlay] could not set model ambient IBL:', e);
          }
        } finally {
          URL.revokeObjectURL(glbUrl);
        }
        if (cancelled) {
          model?.destroy?.();
          return;
        }

        const outcome = await swapCesiumModel(
          viewer.scene.primitives,
          cesiumModelRef.current,
          model,
          (m) => whenModelRenderable(viewer, m),
          () => cancelled,
        );
        // Superseded: a newer build owns the outcome, the globe still shows the
        // previous model, and `model` has already been destroyed. Recording it
        // would leave the refs pointing at geometry nobody is rendering.
        if (outcome === 'superseded' || cancelled) return;
        cesiumModelRef.current = model;
        loadedKeyRef.current = key;
        setCesiumGlbLoaded(true);
        // A rebuild no longer flips `cesiumGlbLoaded` false→true, so that flag
        // can no longer tell the solar effect "there is a different primitive
        // now, re-apply its shadow mode". This epoch does.
        setCesiumModelEpoch((e) => e + 1);
        viewer.scene.requestRender();
      } catch (err) {
        console.warn('[CesiumOverlay] Failed to load IFC model into Cesium:', err);
        // A model built but never installed (the viewer was destroyed mid-load,
        // so `primitives.add` threw) owns GPU buffers nothing will release.
        if (model && cesiumModelRef.current !== model) model.destroy?.();
      }
    };

    const deferTimer = setTimeout(startExport, 1000);

    // Cancel the in-flight build only. Evicting the live model here is what
    // blanked the map on every re-run (#2583); the model is exchanged for its
    // replacement once that replacement exists, and torn down by the
    // no-geometry branch above or with the viewer in Effect 1.
    return () => {
      cancelled = true;
      clearTimeout(deferTimer);
    };
  }, [status, bridgeVersion, geometryResult, geometryContentVersion, visibilityVersion]);

  // ─── Effect 2d: Update model matrix (instant, no reload) ────────────────
  // When terrain placement or georef changes, just update the
  // existing model's matrix — no GLB re-export, no flicker.
  useEffect(() => {
    const model = cesiumModelRef.current;
    const bridge = bridgeRef.current;
    const viewer = viewerRef.current;
    const Cesium = getCesiumModule();
    if (!model || !bridge || !viewer || !Cesium) return;

    const newMatrix = buildModelMatrix(Cesium, bridge, coordinateInfo);
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
