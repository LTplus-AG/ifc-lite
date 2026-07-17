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
 * handler (WebHID's user-gesture requirement). Sensitivity persists in
 * localStorage; the rest is session state.
 */

import type { StateCreator } from 'zustand';
import { SENSITIVITY } from '@/lib/spacemouse/constants';
import type { SpaceMouseDiagnostics } from '@/lib/spacemouse/device';

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
  /** Whether the SpaceMouse panel is open (session only). */
  spaceMousePanelOpen: boolean;
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

  setSpaceMouseSupported: (supported: boolean) => void;
  setSpaceMouseConnected: (connected: boolean, deviceName?: string | null) => void;
  setSpaceMouseError: (error: string | null) => void;
  setSpaceMouseSensitivity: (value: number) => void;
  setSpaceMousePanelOpen: (open: boolean) => void;
  toggleSpaceMousePanel: () => void;
  setSpaceMouseConnect: (connect: (() => void) | null) => void;
  setSpaceMouseDisconnect: (disconnect: (() => void) | null) => void;
  setSpaceMouseGetDiagnostics: (getDiagnostics: (() => SpaceMouseDiagnostics) | null) => void;
}

const STORAGE_KEY = 'ifc-lite:spacemouse';

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
  } catch {
    return SENSITIVITY.default;
  }
}

function persistSensitivity(sensitivity: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sensitivity }));
  } catch { /* storage unavailable */ }
}

export const createSpaceMouseSlice: StateCreator<SpaceMouseSlice, [], [], SpaceMouseSlice> = (set) => ({
  spaceMouseSupported: false,
  spaceMouseConnected: false,
  spaceMouseDeviceName: null,
  spaceMouseError: null,
  spaceMouseSensitivity: loadSensitivity(),
  spaceMousePanelOpen: false,
  spaceMouseConnect: null,
  spaceMouseDisconnect: null,
  spaceMouseGetDiagnostics: null,

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
  setSpaceMousePanelOpen: (spaceMousePanelOpen) => set({ spaceMousePanelOpen }),
  toggleSpaceMousePanel: () => set((s) => ({ spaceMousePanelOpen: !s.spaceMousePanelOpen })),
  setSpaceMouseConnect: (spaceMouseConnect) => set({ spaceMouseConnect }),
  setSpaceMouseDisconnect: (spaceMouseDisconnect) => set({ spaceMouseDisconnect }),
  setSpaceMouseGetDiagnostics: (spaceMouseGetDiagnostics) => set({ spaceMouseGetDiagnostics }),
});
