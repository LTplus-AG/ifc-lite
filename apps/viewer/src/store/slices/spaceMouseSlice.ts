/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SpaceMouse (3Dconnexion) navigation state.
 *
 * Owns only lightweight UI state: whether WebHID is available, whether a
 * device is connected, its name, the last connection error and the user's
 * sensitivity. The actual WebHID connection + per-frame camera driving lives
 * in `useSpaceMouseControls` (it needs the renderer); the hook registers its
 * `connect` action here so the panel button can trigger it inside a click
 * handler (WebHID's user-gesture requirement). Sensitivity and the
 * "Use the 3Dconnexion driver" opt-in (#9131) persist in localStorage; the
 * rest is session state.
 */

import type { StateCreator } from 'zustand';
import { SENSITIVITY } from '@/lib/spacemouse/constants';
import type { SpaceMouseDiagnostics } from '@/lib/spacemouse/device';

/**
 * Where the opt-in 3Dconnexion driver path stands (#9131). `off` while the
 * setting is off; `unavailable` when the driver did not answer, in which case
 * the WebHID path stays in use.
 */
export type SpaceMouseDriverStatus = 'off' | 'connecting' | 'connected' | 'unavailable';

export interface SpaceMouseSlice {
  /** True when navigator.hid exists (Chromium-based browsers). */
  spaceMouseSupported: boolean;
  /** True while a device is granted, opened and streaming. */
  spaceMouseConnected: boolean;
  /** Product name of the connected device, or null. */
  spaceMouseDeviceName: string | null;
  /** Human-readable connection error, or null. */
  spaceMouseError: string | null;
  /** User sensitivity multiplier (persisted). */
  spaceMouseSensitivity: number;
  /**
   * Connect action registered by `useSpaceMouseControls` (which owns the
   * renderer). The panel calls this inside a click handler so WebHID's
   * user-gesture requirement for `requestDevice` is satisfied.
   */
  spaceMouseConnect: (() => void) | null;
  /** Disconnect action registered by `useSpaceMouseControls` while connected. */
  spaceMouseDisconnect: (() => void) | null;
  /**
   * Diagnostics snapshot getter registered while connected. The panel polls it
   * at UI rate (device reports stream at ~125Hz; routing every sample through
   * the store would be waste).
   */
  spaceMouseGetDiagnostics: (() => SpaceMouseDiagnostics) | null;
  /** "Use the 3Dconnexion driver" (persisted, off by default). */
  spaceMouseUseDriver: boolean;
  /** State of the driver path; see {@link SpaceMouseDriverStatus}. */
  spaceMouseDriverStatus: SpaceMouseDriverStatus;
  /** Why the driver path is `unavailable`, for a tooltip; null otherwise. */
  spaceMouseDriverError: string | null;

  setSpaceMouseSupported: (supported: boolean) => void;
  setSpaceMouseConnected: (connected: boolean, deviceName?: string | null) => void;
  setSpaceMouseError: (error: string | null) => void;
  setSpaceMouseSensitivity: (value: number) => void;
  setSpaceMouseConnect: (connect: (() => void) | null) => void;
  setSpaceMouseDisconnect: (disconnect: (() => void) | null) => void;
  setSpaceMouseGetDiagnostics: (getDiagnostics: (() => SpaceMouseDiagnostics) | null) => void;
  setSpaceMouseUseDriver: (useDriver: boolean) => void;
  setSpaceMouseDriverStatus: (status: SpaceMouseDriverStatus, error?: string | null) => void;
}

const STORAGE_KEY = 'ifc-lite:spacemouse';
/** Separate key, so the existing `{ sensitivity }` entry keeps its shape. */
const DRIVER_STORAGE_KEY = 'ifc-lite:spacemouse-driver';

function clampSensitivity(value: number): number {
  if (!Number.isFinite(value)) return SENSITIVITY.default;
  return Math.min(SENSITIVITY.max, Math.max(SENSITIVITY.min, value));
}

function loadSensitivity(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return SENSITIVITY.default;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && 'sensitivity' in parsed) {
      return clampSensitivity((parsed as { sensitivity: number }).sensitivity);
    }
    return SENSITIVITY.default;
  } catch (err) {
    console.warn('[spacemouse] ignoring an unreadable sensitivity preference:', err);
    return SENSITIVITY.default;
  }
}

function persistSensitivity(sensitivity: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sensitivity }));
  } catch (err) {
    console.warn('[spacemouse] could not persist the sensitivity preference:', err);
  }
}

function loadUseDriver(): boolean {
  try {
    const raw = localStorage.getItem(DRIVER_STORAGE_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && 'enabled' in parsed && parsed.enabled === true;
  } catch (err) {
    console.warn('[spacemouse] ignoring an unreadable 3Dconnexion driver preference:', err);
    return false;
  }
}

function persistUseDriver(enabled: boolean): void {
  try {
    localStorage.setItem(DRIVER_STORAGE_KEY, JSON.stringify({ enabled }));
  } catch (err) {
    console.warn('[spacemouse] could not persist the 3Dconnexion driver preference:', err);
  }
}

export const createSpaceMouseSlice: StateCreator<SpaceMouseSlice, [], [], SpaceMouseSlice> = (set) => ({
  spaceMouseSupported: false,
  spaceMouseConnected: false,
  spaceMouseDeviceName: null,
  spaceMouseError: null,
  spaceMouseSensitivity: loadSensitivity(),
  spaceMouseConnect: null,
  spaceMouseDisconnect: null,
  spaceMouseGetDiagnostics: null,
  spaceMouseUseDriver: loadUseDriver(),
  spaceMouseDriverStatus: 'off',
  spaceMouseDriverError: null,

  setSpaceMouseSupported: (spaceMouseSupported) => set({ spaceMouseSupported }),
  setSpaceMouseConnected: (spaceMouseConnected, deviceName = null) =>
    set({
      spaceMouseConnected,
      spaceMouseDeviceName: spaceMouseConnected ? deviceName : null,
      // A successful connection clears any stale error.
      ...(spaceMouseConnected ? { spaceMouseError: null } : {}),
    }),
  setSpaceMouseError: (spaceMouseError) => set({ spaceMouseError }),
  setSpaceMouseSensitivity: (value) => {
    const spaceMouseSensitivity = clampSensitivity(value);
    persistSensitivity(spaceMouseSensitivity);
    set({ spaceMouseSensitivity });
  },
  setSpaceMouseConnect: (spaceMouseConnect) => set({ spaceMouseConnect }),
  setSpaceMouseDisconnect: (spaceMouseDisconnect) => set({ spaceMouseDisconnect }),
  setSpaceMouseGetDiagnostics: (spaceMouseGetDiagnostics) => set({ spaceMouseGetDiagnostics }),
  setSpaceMouseUseDriver: (spaceMouseUseDriver) => {
    persistUseDriver(spaceMouseUseDriver);
    set({ spaceMouseUseDriver });
  },
  setSpaceMouseDriverStatus: (spaceMouseDriverStatus, error = null) =>
    set({
      spaceMouseDriverStatus,
      spaceMouseDriverError: spaceMouseDriverStatus === 'unavailable' ? error : null,
    }),
});
