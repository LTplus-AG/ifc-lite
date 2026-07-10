/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SpaceMouse (3Dconnexion) controls hook for the 3D viewport (#1677).
 *
 * Bridges the WebHID device session to the camera: runs its own RAF loop while
 * a device is connected (the same idiom as useKeyboardControls' movement
 * loop), polls the latest 6DoF sample each frame, maps it to mouse-equivalent
 * orbit / pan / zoom deltas and feeds the existing Camera controls. The
 * device's fit buttons reuse the keyboard 'F' behaviour (frame selection, or
 * zoom extents with nothing selected).
 *
 * The hook registers a `connect` action in the store so the SpaceMouse panel
 * can trigger the WebHID permission prompt from a click (user-gesture
 * requirement), and silently reopens a previously granted device on startup.
 */

import { useEffect, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import {
  connectSpaceMouse,
  isWebHidSupported,
  reconnectGrantedSpaceMouse,
  type SpaceMouseSession,
} from '@/lib/spacemouse/device';
import { deltasAreZero, mapSixDofToCameraDeltas } from '@/lib/spacemouse/mapping';
import { getEntityBounds } from '../../utils/viewportUtils.js';

export interface UseSpaceMouseControlsParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  geometryBoundsRef: MutableRefObject<{ min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }>;
  geometryRef: MutableRefObject<MeshData[] | null>;
  selectedEntityIdRef: MutableRefObject<number | null>;
  calculateScale: () => void;
}

/**
 * Frames longer than this (background tab, debugger pause) are clamped so the
 * first frame back cannot integrate seconds of deflection into one huge jump.
 */
const MAX_FRAME_MS = 100;

export function useSpaceMouseControls(params: UseSpaceMouseControlsParams): void {
  const {
    rendererRef,
    isInitialized,
    geometryBoundsRef,
    geometryRef,
    selectedEntityIdRef,
    calculateScale,
  } = params;

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;

    const store = useViewerStore.getState();
    const supported = isWebHidSupported();
    store.setSpaceMouseSupported(supported);
    if (!supported) return;

    const camera = renderer.getCamera();
    let aborted = false;
    let session: SpaceMouseSession | null = null;
    let frameId: number | null = null;
    let lastFrameTime = 0;

    // Same behaviour as the keyboard 'F' shortcut.
    const fitView = () => {
      const selectedId = selectedEntityIdRef.current;
      if (selectedId !== null) {
        const bounds = getEntityBounds(geometryRef.current, selectedId);
        if (bounds) {
          void camera.frameBounds(bounds.min, bounds.max, 300);
          renderer.requestRender();
          calculateScale();
          return;
        }
      }
      void camera.zoomExtent(geometryBoundsRef.current.min, geometryBoundsRef.current.max, 300);
      renderer.requestRender();
      calculateScale();
    };

    const stopLoop = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
    };

    const spaceMouseMove = (now: number) => {
      if (aborted || !session) return;

      const deltaMs = Math.min(now - lastFrameTime, MAX_FRAME_MS);
      lastFrameTime = now;

      const sensitivity = useViewerStore.getState().spaceMouseSensitivity;
      const deltas = mapSixDofToCameraDeltas(session.getState(), sensitivity, deltaMs);
      if (!deltasAreZero(deltas)) {
        if (deltas.orbitDx !== 0 || deltas.orbitDy !== 0) {
          camera.orbit(deltas.orbitDx, deltas.orbitDy, false);
        }
        if (deltas.panDx !== 0 || deltas.panDy !== 0) {
          camera.pan(deltas.panDx, deltas.panDy, false);
        }
        if (deltas.zoomDelta !== 0) {
          camera.zoom(deltas.zoomDelta, false);
        }
        renderer.requestRender();
      }

      frameId = requestAnimationFrame(spaceMouseMove);
    };

    const startLoop = () => {
      stopLoop();
      lastFrameTime = performance.now();
      frameId = requestAnimationFrame(spaceMouseMove);
    };

    const sessionOptions = {
      onFitButton: fitView,
      onDisconnect: () => {
        session = null;
        stopLoop();
        if (!aborted) {
          const s = useViewerStore.getState();
          s.setSpaceMouseConnected(false);
          s.setSpaceMouseDisconnect(null);
        }
      },
    };

    const adopt = (next: SpaceMouseSession | null) => {
      if (!next) return;
      if (aborted || session) {
        // Torn down (or a device already streams) before the open resolved.
        void next.close();
        return;
      }
      session = next;
      const s = useViewerStore.getState();
      s.setSpaceMouseConnected(true, next.productName);
      s.setSpaceMouseDisconnect(() => { void next.close(); });
      startLoop();
    };

    const connect = async () => {
      if (session) return;
      try {
        adopt(await connectSpaceMouse(sessionOptions));
      } catch (err) {
        if (!aborted) {
          useViewerStore.getState().setSpaceMouseError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    store.setSpaceMouseConnect(() => { void connect(); });

    // Reopen a device granted in an earlier visit, without prompting.
    void reconnectGrantedSpaceMouse(sessionOptions).then(adopt);

    // When a granted device is plugged back in, pick it up automatically.
    const handleHidConnect = () => {
      if (!session && !aborted) void reconnectGrantedSpaceMouse(sessionOptions).then(adopt);
    };
    navigator.hid?.addEventListener('connect', handleHidConnect);

    return () => {
      aborted = true;
      stopLoop();
      navigator.hid?.removeEventListener('connect', handleHidConnect);
      const s = useViewerStore.getState();
      s.setSpaceMouseConnect(null);
      s.setSpaceMouseDisconnect(null);
      s.setSpaceMouseConnected(false);
      void session?.close();
      session = null;
    };
  }, [isInitialized]);
}

export default useSpaceMouseControls;
