/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What happens when a load lands: announce it, and frame the first model.
 *
 * Unlike the full viewer (which has toolbar buttons for fit-all and a default
 * load flow that fits), the embed has no chrome — so without an explicit fit
 * call the camera stays at its initial position and the model renders
 * off-frame. Only the FIRST successful load is framed, so host-driven
 * SET_CAMERA / view params via the bridge aren't immediately overridden.
 *
 * The pose a host commanded during the load is applied by `cameraIntent.ts`,
 * not here (#3390) — this hook only asks whether there was one, because the
 * `home()` it would otherwise use for framing animates that pose away.
 */

import { useEffect, useRef } from 'react';
import { useViewerStore } from '@/store';
import type { ViewerState } from '@/store';
import { emitEvent } from '../bridge/handler.js';
import { hostPoseAppliedToCurrentModel } from '../bridge/cameraIntent.js';
import type { EmbedViewerUrlParams } from '../bridge/urlParams.js';

export function useEmbedPostLoad(
  loading: boolean,
  geometryResult: ViewerState['geometryResult'],
  ifcDataStore: ViewerState['ifcDataStore'],
  urlParams: EmbedViewerUrlParams,
): void {
  const autoFittedRef = useRef(false);

  useEffect(() => {
    if (loading) return;

    const meshes = geometryResult?.meshes;
    if (!meshes || meshes.length === 0) return;

    emitEvent('MODEL_LOADED', {
      entities: ifcDataStore?.entities?.count ?? 0,
      triangles: geometryResult.totalTriangles,
      vertices: geometryResult.totalVertices,
    });

    if (autoFittedRef.current) return;

    // Viewport registers cameraCallbacks AFTER renderer.init() resolves (async).
    // On a fast network + small model, geometry can land before that happens.
    // Poll for up to ~2 s, checking each frame, then bail out so we never leak.
    autoFittedRef.current = true;
    const deadline = performance.now() + 2000;
    let rafId = 0;
    const tryFit = () => {
      const cbs = useViewerStore.getState().cameraCallbacks;
      const ready = Boolean(cbs.home || cbs.fitAll || cbs.setPresetView);
      if (!ready) {
        if (performance.now() < deadline) {
          rafId = requestAnimationFrame(tryFit);
        } else {
          console.warn('[embed] auto-fit gave up — cameraCallbacks never registered');
        }
        return;
      }
      // Orientation FIRST, then fit, wherever one was asked for.
      // `setCameraRotation` keeps the current target and orbit distance
      // (Camera.setRotation), so on its own it aims an unframed camera at
      // nothing; `fitAll` zooms to the model "without changing view direction",
      // so it preserves the orientation just asked for. The reverse order loses
      // the rotation, because `home`/`fitAll` animate and the snap would be
      // tweened away.
      if (hostPoseAppliedToCurrentModel()) {
        // The host commanded a pose for this very model while it was loading
        // (#3390) and `aroundDestructiveLoad` has already applied it. That
        // outranks the static URL params — and `home()` below would tween it
        // straight out again, the same clobber #3390 reports, reached from the
        // framing side rather than through the session reset.
        cbs.fitAll?.();
      } else if (urlParams.view) {
        cbs.setPresetView?.(urlParams.view);
      } else if (urlParams.camera) {
        // The payload's `zoom` is NOT applied: there is no absolute-zoom
        // actuator (`zoomIn`/`zoomOut` are unitless steppers) and the protocol
        // gives the field no unit, so any mapping would be invented. Framing
        // comes from `fitAll` instead. See #2934.
        useViewerStore.getState().setCameraRotation({
          azimuth: urlParams.camera.azimuth,
          elevation: urlParams.camera.elevation,
        });
        cbs.fitAll?.();
      } else if (cbs.home) {
        cbs.home();
      } else if (cbs.fitAll) {
        cbs.fitAll();
      }
    };
    rafId = requestAnimationFrame(tryFit);
    return () => cancelAnimationFrame(rafId);
  }, [loading, geometryResult, ifcDataStore, urlParams.view, urlParams.camera]);
}
