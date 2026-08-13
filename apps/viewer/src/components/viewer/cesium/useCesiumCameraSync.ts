/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drives the Cesium camera from the IFC viewer's camera, every frame.
 *
 * Split out of CesiumOverlay.tsx (#2593). The two canvases are composited, not
 * shared: the WebGPU viewport owns user input and this loop mirrors its pose
 * into ECEF so the globe stays underneath the model. It is the only per-frame
 * work in the overlay, which is reason enough for it to be its own file.
 */

import { useEffect, type RefObject } from 'react';
import type { CesiumBridge } from '@/lib/geo/cesium-bridge';
import { getGlobalRenderer } from '@/hooks/useBCF';
import { getCesiumModule } from './cesium-module';

export interface UseCesiumCameraSyncParams {
  status: 'idle' | 'loading' | 'ready' | 'error';
  viewerRef: RefObject<InstanceType<typeof import('cesium').Viewer> | null>;
  bridgeRef: RefObject<CesiumBridge | null>;
  /** The camera-side bridge, which may differ from the model's while a
   *  placement draft is previewing; falls back to `bridgeRef`. */
  cameraBridgeRef: RefObject<CesiumBridge | null>;
  /** Terrain clip height, re-read each frame. */
  terrainClipY: number | null;
  /**
   * Owned by the CALLER, not this hook. The viewer effect cancels the loop from
   * its own cleanup, which runs BEFORE this hook re-runs — without that, the
   * loop can tick once against a viewer that has just been destroyed.
   */
  rafRef: RefObject<number | null>;
}

export function useCesiumCameraSync({
  status,
  viewerRef,
  bridgeRef,
  cameraBridgeRef,
  terrainClipY,
  rafRef,
}: UseCesiumCameraSyncParams): void {

  // ─── Effect 3: Camera sync loop ─────────────────────────────────────────
  useEffect(() => {
    if (status !== 'ready') return;

    const viewer = viewerRef.current;
    if (!viewer) return;

    let cancelled = false;

    function syncCamera() {
      if (cancelled) return;

      const bridge = bridgeRef.current;
      const cameraBridge = cameraBridgeRef.current ?? bridge;
      const renderer = getGlobalRenderer();
      const Cesium = getCesiumModule();
      if (!viewer || !bridge || !cameraBridge || !renderer || !Cesium) {
        rafRef.current = requestAnimationFrame(syncCamera);
        return;
      }

      const camera = renderer.getCamera();
      let camPos = camera.getPosition();
      let camTarget = camera.getTarget();
      const camUp = camera.getUp();
      const fov = camera.getFOV();

      if (terrainClipY !== null) {
        const minCameraY = terrainClipY + 0.05;
        if (camPos.y < minCameraY) {
          const dy = minCameraY - camPos.y;
          camPos = { ...camPos, y: minCameraY };
          camTarget = { ...camTarget, y: camTarget.y + dy };
        }
      }

      // bridge.modelOrigin.height already has the placement baked in, so the
      // camera frame and the model matrix share the same enuToEcef origin altitude.
      cameraBridge.syncCamera(Cesium, viewer, camPos, camTarget, camUp, fov);

      rafRef.current = requestAnimationFrame(syncCamera);
    }

    rafRef.current = requestAnimationFrame(syncCamera);

    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [status, terrainClipY]);
}
