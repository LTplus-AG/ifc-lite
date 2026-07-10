/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 3Dconnexion SpaceMouse navigation via WebHID.
 *
 * WebHID is Chromium-only, so the whole feature feature-detects `navigator.hid`
 * and does nothing (and the UI hides) elsewhere. The hook:
 *   - feature-detects support and publishes it to the store,
 *   - exposes a `connect` action (registered in the store) that the toolbar
 *     calls inside a click handler — WebHID `requestDevice` needs a user
 *     gesture,
 *   - auto-reconnects a previously granted device on load via `getDevices()`
 *     (no new prompt),
 *   - parses `inputreport` events into a shared 6DoF ref, and
 *   - drives the existing Camera controls once per animation frame through
 *     `driveRef` (the shared render loop calls it — no second rAF).
 *
 * We cannot verify against real hardware in CI; the parser + mapping are pure
 * and unit-tested, and every device-specific constant lives in
 * `lib/spacemouse/constants.ts` for a one-line fix if a variant differs.
 */

import { useEffect, type MutableRefObject } from 'react';
import type { Camera } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { SPACEMOUSE_VENDOR_ID } from '@/lib/spacemouse/constants';
import { parseSpaceMouseReport, zeroSixDof, type SixDof } from '@/lib/spacemouse/parser';
import { mapSixDofToCameraDeltas, deltasAreZero, isInputStale } from '@/lib/spacemouse/mapping';

/** Per-frame camera driver: applies the latest 6DoF sample; returns true if it moved the camera. */
export type SpaceMouseDrive = (camera: Camera, deltaMs: number) => boolean;

export interface UseSpaceMouseParams {
  /**
   * Populated by this hook; read by the shared animation loop each frame. The
   * loop owns the renderer/camera, so the hook needs nothing but this ref.
   */
  driveRef: MutableRefObject<SpaceMouseDrive | null>;
}

function isSpaceMouse(device: HIDDevice): boolean {
  return device.vendorId === SPACEMOUSE_VENDOR_ID;
}

export function useSpaceMouse({ driveRef }: UseSpaceMouseParams): void {
  useEffect(() => {
    const hid = navigator.hid;
    const setSupported = useViewerStore.getState().setSpaceMouseSupported;
    const setConnected = useViewerStore.getState().setSpaceMouseConnected;
    const setConnect = useViewerStore.getState().setSpaceMouseConnect;

    if (!hid) {
      setSupported(false);
      return;
    }
    setSupported(true);

    // Latest 6DoF sample, updated by inputreport; read each frame by the driver.
    const state: SixDof = zeroSixDof();
    let activeDevice: HIDDevice | null = null;
    let disposed = false;
    // Timestamp of the last input report - the silent-stall watchdog. A HID
    // stack that stops emitting reports WITHOUT a disconnect event would
    // otherwise latch the last non-zero sample and drive the camera forever.
    let lastReportAt = Number.NEGATIVE_INFINITY;

    const onInputReport = (event: HIDInputReportEvent) => {
      const next = parseSpaceMouseReport(event.reportId, event.data, state);
      state.tx = next.tx; state.ty = next.ty; state.tz = next.tz;
      state.rx = next.rx; state.ry = next.ry; state.rz = next.rz;
      lastReportAt = performance.now();
    };

    const resetState = () => {
      state.tx = 0; state.ty = 0; state.tz = 0;
      state.rx = 0; state.ry = 0; state.rz = 0;
    };

    const detachDevice = () => {
      if (activeDevice) {
        activeDevice.removeEventListener('inputreport', onInputReport);
        activeDevice = null;
      }
      resetState();
    };

    const openDevice = async (device: HIDDevice) => {
      try {
        if (!device.opened) await device.open();
        if (disposed) return;
        // Re-point the single listener at this device (idempotent across HMR).
        detachDevice();
        activeDevice = device;
        device.addEventListener('inputreport', onInputReport);
        setConnected(true, device.productName || 'SpaceMouse');
      } catch (err) {
        // Open can fail (device busy, permission revoked). Stay disconnected.
        console.warn('[SpaceMouse] failed to open device', err);
        setConnected(false);
      }
    };

    // User-gesture entry point (from the toolbar). Prompts for a device.
    const connect = () => {
      void (async () => {
        try {
          const devices = await hid.requestDevice({
            filters: [{ vendorId: SPACEMOUSE_VENDOR_ID }],
          });
          const device = devices.find(isSpaceMouse) ?? devices[0];
          if (device) await openDevice(device);
        } catch (err) {
          console.warn('[SpaceMouse] requestDevice failed', err);
        }
      })();
    };
    setConnect(connect);

    // Auto-reconnect a previously granted device without a prompt.
    void (async () => {
      try {
        const devices = await hid.getDevices();
        if (disposed) return;
        const device = devices.find(isSpaceMouse);
        if (device) await openDevice(device);
      } catch { /* getDevices unavailable — wait for explicit connect */ }
    })();

    // Unplug handling: clean up if OUR device disconnects.
    const onDisconnect = (event: HIDConnectionEvent) => {
      // ONLY tear down for the device we are actually bound to. Matching any
      // SpaceMouse here killed the ACTIVE device's session when a second,
      // unused SpaceMouse was unplugged (adversarial finding on #1688).
      if (event.device === activeDevice) {
        detachDevice();
        setConnected(false);
      }
    };
    hid.addEventListener('disconnect', onDisconnect);

    // Per-frame driver — installed into the shared render loop.
    driveRef.current = (camera: Camera, deltaMs: number): boolean => {
      if (!activeDevice) return false;
      // Silent-stall watchdog: a report older than the timeout no longer
      // drives the camera (and the latched sample is cleared so recovery
      // starts from rest).
      if (isInputStale(lastReportAt, performance.now())) {
        resetState();
        return false;
      }
      const sensitivity = useViewerStore.getState().spaceMouseSensitivity;
      const deltas = mapSixDofToCameraDeltas(state, sensitivity, deltaMs);
      if (deltasAreZero(deltas)) return false;

      if (deltas.orbitDx !== 0 || deltas.orbitDy !== 0) {
        camera.orbit(deltas.orbitDx, deltas.orbitDy, false);
      }
      if (deltas.panDx !== 0 || deltas.panDy !== 0) {
        camera.pan(deltas.panDx, deltas.panDy, false);
      }
      if (deltas.zoomDelta !== 0) {
        camera.zoom(deltas.zoomDelta, false);
      }
      return true;
    };

    return () => {
      disposed = true;
      driveRef.current = null;
      hid.removeEventListener('disconnect', onDisconnect);
      detachDevice();
      // Leave the device open so a granted device auto-reconnects on next mount
      // / HMR without re-prompting; just drop the connect binding + status.
      setConnect(null);
      setConnected(false);
    };
    // Bind once. `driveRef` is a stable ref and the store is read lazily via
    // getState(), so there is no dependency that should re-bind the listeners.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export default useSpaceMouse;
