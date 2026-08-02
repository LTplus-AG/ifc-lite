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
import { deltasAreZero, isInputStale, mapSixDofToCameraDeltas } from '@/lib/spacemouse/mapping';
import { getEntityBounds } from '../../utils/viewportUtils.js';

export interface UseSpaceMouseControlsParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  geometryBoundsRef: MutableRefObject<{ min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }>;
  geometryRef: MutableRefObject<MeshData[] | null>;
  selectedEntityIdRef: MutableRefObject<number | null>;
  calculateScale: () => void;
}

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

      // The mapping caps deltaMs (MAX_FRAME_DELTA_MS) so a backgrounded tab
      // cannot teleport the camera; the staleness watchdog stops a silent
      // HID stall (no disconnect event) from latching the last sample.
      const deltaMs = now - lastFrameTime;
      lastFrameTime = now;

      const stale = isInputStale(session.getLastSampleAt(), now);
      const sensitivity = useViewerStore.getState().spaceMouseSensitivity;
      const deltas = stale
        ? null
        : mapSixDofToCameraDeltas(session.getState(), sensitivity, deltaMs);
      if (deltas && !deltasAreZero(deltas)) {
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
          s.setSpaceMouseGetDiagnostics(null);
        }
      },
    };

    const adopt = (next: SpaceMouseSession | null) => {
      if (!next) return;
      if (aborted || session) {
        // Torn down (or a device already streams) before this open resolved.
        // Detach quietly: close() would fire the shared onDisconnect and, when
        // overlapping connects wrapped the SAME HIDDevice, close the winner's
        // device out from under it. Only close the physical device when it is
        // not the active session's.
        const sharesDevice = session?.device === next.device;
        next.detach();
        if (!sharesDevice) {
          next.device.close().catch(() => { /* already closed / gone */ });
        }
        return;
      }
      session = next;
      const s = useViewerStore.getState();
      s.setSpaceMouseConnected(true, next.productName);
      s.setSpaceMouseDisconnect(() => { void next.close(); });
      s.setSpaceMouseGetDiagnostics(() => next.getDiagnostics());
      startLoop();
    };

    // Serialize connect attempts: a manual Connect click overlapping the
    // startup reconnect (or a double-click) must not produce two sessions
    // racing over the same device.
    let connectInFlight = false;

    const connect = async () => {
      if (session || connectInFlight) return;
      connectInFlight = true;
      try {
        adopt(await connectSpaceMouse(sessionOptions));
      } catch (err) {
        if (!aborted) {
          useViewerStore.getState().setSpaceMouseError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        connectInFlight = false;
      }
    };

    const reconnect = async () => {
      if (session || connectInFlight || aborted) return;
      connectInFlight = true;
      try {
        adopt(await reconnectGrantedSpaceMouse(sessionOptions));
      } finally {
        connectInFlight = false;
      }
    };

    store.setSpaceMouseConnect(() => { void connect(); });

    // Reopen a device granted in an earlier visit, without prompting.
    void reconnect();

    // When a granted device is plugged back in, pick it up automatically.
    const handleHidConnect = () => {
      void reconnect();
    };
    navigator.hid?.addEventListener('connect', handleHidConnect);

    return () => {
      aborted = true;
      stopLoop();
      navigator.hid?.removeEventListener('connect', handleHidConnect);
      const s = useViewerStore.getState();
      s.setSpaceMouseConnect(null);
      s.setSpaceMouseDisconnect(null);
      s.setSpaceMouseGetDiagnostics(null);
      s.setSpaceMouseConnected(false);
      void session?.close();
      session = null;
    };
  }, [isInitialized]);
}

export default useSpaceMouseControls;
