/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The load-time geometry settings: merge-layers, the Fast/Exact fidelity mode,
 * and the sticky `?geomTier=` tessellation pin.
 *
 * Split out of `uiSlice.ts` (which composes it, so the store shape is
 * unchanged) because these share one contract that none of the slice's other
 * state has: each is read only on the NEXT model load, is folded into the
 * geometry cache key, and therefore has to prompt a reload when a model is
 * already in scope. `uiSlice.ts` is well past the ~400-line house limit and this
 * was its most self-contained block.
 */

import {
  GEOMETRY_MODE_STORAGE_KEY,
  MERGE_LAYERS_STORAGE_KEY,
  UI_DEFAULTS,
  clearGeomTierOverride as clearStoredGeomTier,
  type GeometryMode,
} from '../constants.js';
import type { TessellationQuality } from '@ifc-lite/geometry';

/**
 * Which load-time geometry input armed the reload prompt, so the banner names
 * the change the user actually made rather than always reporting the mode.
 */
export type GeometryReloadReason = 'mode' | 'tier';

export interface GeometryLoadSettingsState {
  /**
   * Issue #540 - "Merge Multilayer Walls" load-time toggle. Reading this on
   * next file load is what the WASM bridge actually uses; flipping it while a
   * model is in scope sets `mergeLayersPendingReload` so the UI can prompt.
   */
  mergeLayers: boolean;
  /** True after the user flipped `mergeLayers` while a model was loaded. */
  mergeLayersPendingReload: boolean;
  /**
   * Load-time geometry fidelity mode (`fast` = skip tiny cuts + auto-low
   * density; `exact` = full fidelity). Like `mergeLayers`, it is read on the
   * next file load.
   */
  geometryMode: GeometryMode;
  /**
   * True after a load-time geometry input changed while a model was loaded:
   * either `geometryMode` or the pinned tessellation tier. One flag, one
   * banner - `geometryReloadReason` says which, so the prompt can name it.
   */
  geometryModePendingReload: boolean;
  /** Which load-time geometry input armed `geometryModePendingReload`. */
  geometryReloadReason: GeometryReloadReason;
  /**
   * Stored `?geomTier=` tessellation override, or `undefined` when the tier is
   * chosen automatically. Mirrored into the store so the Visibility menu can
   * surface it: it persists from a single link visit and, before #2544, was
   * invisible with no way out but `?geomTier=auto` or clearing site data.
   */
  geomTierOverride: TessellationQuality | undefined;
}

export interface GeometryLoadSettingsActions {
  /** Update the merge-layers toggle and persist to localStorage. */
  setMergeLayers: (v: boolean) => void;
  /** Acknowledge the merge-layers reload banner without performing a reload. */
  clearMergeLayersPendingReload: () => void;
  /** Update the geometry fidelity mode and persist to localStorage. */
  setGeometryMode: (v: GeometryMode) => void;
  /** Acknowledge the geometry reload banner without performing a reload. */
  clearGeometryModePendingReload: () => void;
  /**
   * Drop a pinned `?geomTier=` override and return to automatic tier selection,
   * arming the reload prompt when a model is in scope (#2544).
   */
  clearGeomTierOverride: () => void;
}

export const geometryLoadSettingsInitialState: GeometryLoadSettingsState = {
  mergeLayers: UI_DEFAULTS.MERGE_LAYERS,
  mergeLayersPendingReload: false,
  geometryMode: UI_DEFAULTS.GEOMETRY_MODE,
  geometryModePendingReload: false,
  geometryReloadReason: 'mode',
  geomTierOverride: UI_DEFAULTS.GEOM_TIER_OVERRIDE,
};

/**
 * Build the load-time geometry actions.
 *
 * `isModelLoaded` is injected rather than read from a cross-slice `get()` so
 * this module needs no knowledge of the rest of the store (and no import cycle
 * back into `uiSlice`); the caller owns that question.
 */
export function createGeometryLoadSettings(
  set: (partial: Partial<GeometryLoadSettingsState>) => void,
  get: () => GeometryLoadSettingsState,
  isModelLoaded: () => boolean,
): GeometryLoadSettingsActions {
  return {
    setMergeLayers: (next) => {
      if (get().mergeLayers === next) return;
      // Persist eagerly so the next page-load picks the same value up through
      // `getInitialMergeLayers` (constants.ts). Wrap in try/catch - Safari
      // private mode / locked storage throws.
      try {
        localStorage.setItem(MERGE_LAYERS_STORAGE_KEY, String(next));
      } catch {
        /* storage unavailable - accept the in-memory toggle silently */
      }
      // Only ask the user to reload if a model is currently in scope. Toggling
      // on an empty viewer simply changes the future load with no visible
      // effect.
      set({ mergeLayers: next, mergeLayersPendingReload: isModelLoaded() });
    },

    clearMergeLayersPendingReload: () => set({ mergeLayersPendingReload: false }),

    setGeometryMode: (next) => {
      if (get().geometryMode === next) return;
      // Persist eagerly so the next page-load picks the same value up through
      // `getInitialGeometryMode`.
      try {
        localStorage.setItem(GEOMETRY_MODE_STORAGE_KEY, next);
      } catch (err) {
        // Storage unavailable - accept the in-memory toggle, but don't swallow
        // silently (AGENTS.md: no silent catch). The choice won't persist.
        console.warn('[geometry-mode] persist failed; in-memory only', err);
      }
      set({
        geometryMode: next,
        geometryModePendingReload: isModelLoaded(),
        geometryReloadReason: 'mode',
      });
    },

    clearGeometryModePendingReload: () => set({ geometryModePendingReload: false }),

    clearGeomTierOverride: () => {
      if (get().geomTierOverride === undefined) return;
      clearStoredGeomTier();
      // Same reload-to-apply contract as the mode switch: the tier is a
      // load-time tessellation input folded into the geometry cache key, so the
      // model in scope keeps its pinned-tier geometry until it is re-meshed.
      set({
        geomTierOverride: undefined,
        geometryModePendingReload: isModelLoaded(),
        geometryReloadReason: 'tier',
      });
    },
  };
}
