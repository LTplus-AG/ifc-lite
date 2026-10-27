/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Globe placement" for the Cesium world view (`lib/geo/globe-placement.ts`):
 * the user's choice, persisted per browser, and what the bridge resolved it to.
 * Type-only imports, so the store does not pull proj4 into the entry chunk.
 */

import type { StateCreator } from 'zustand';
import type { GlobePlacementMode, ResolvedGlobePlacement } from '@/lib/geo/globe-placement';

const STORAGE_KEY = 'ifc-lite:cesium-globe-placement';

export interface GlobePlacementStatus {
  mode: ResolvedGlobePlacement;
  /** Estimated anchor-placement error, metres; null when it could not be estimated. */
  anchorErrorMetres: number | null;
}

export interface GlobePlacementSlice {
  cesiumGlobePlacement: GlobePlacementMode;
  /** Published by the bridge for the Georeferencing panel; null while none is built. */
  cesiumGlobePlacementStatus: GlobePlacementStatus | null;
  setCesiumGlobePlacement: (mode: GlobePlacementMode) => void;
  setCesiumGlobePlacementStatus: (status: GlobePlacementStatus | null) => void;
}

function loadMode(): GlobePlacementMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'anchor' || stored === 'exact' ? stored : 'auto';
  } catch (error) {
    console.warn('[cesium] globe placement setting not restored', error);
    return 'auto';
  }
}

export const createGlobePlacementSlice: StateCreator<GlobePlacementSlice, [], [], GlobePlacementSlice> = (set) => ({
  cesiumGlobePlacement: loadMode(),
  cesiumGlobePlacementStatus: null,
  setCesiumGlobePlacement: (mode) => {
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch (error) {
      console.warn('[cesium] globe placement setting not persisted', error);
    }
    set({ cesiumGlobePlacement: mode });
  },
  setCesiumGlobePlacementStatus: (status) => set({ cesiumGlobePlacementStatus: status }),
});
