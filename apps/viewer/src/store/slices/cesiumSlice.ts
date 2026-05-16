/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cesium 3D Tiles overlay state slice.
 *
 * Manages the enabled/disabled state, selected data source, and Cesium ion
 * access token for the optional real-world 3D context overlay.
 *
 * Token resolution:
 *   1. User-provided override in localStorage
 *   2. Build-time default token via VITE_CESIUM_ION_TOKEN env var
 *   → Users never need to configure anything; the app ships with a working token.
 */

import type { StateCreator } from 'zustand';
import type { MapConversion } from '@ifc-lite/parser';

import { clearTerrainElevationCache } from '@/lib/geo/terrain-elevation';

export type CesiumDataSource = 'google-photorealistic';

export interface CesiumPlacementDraft {
  eastings: number;
  northings: number;
  orthogonalHeight: number;
  xAxisAbscissa: number;
  xAxisOrdinate: number;
}

export interface CesiumSlice {
  // State
  /** Whether a loaded model (or user mutations) provide enough georeferencing to place in Cesium. */
  cesiumAvailable: boolean;
  cesiumEnabled: boolean;
  cesiumDataSource: CesiumDataSource;
  /** Resolved Cesium ion access token (user override or build-time default). */
  cesiumIonToken: string;
  /** Terrain enabled (Cesium World Terrain). */
  cesiumTerrainEnabled: boolean;
  /** Terrain height at model position (queried from Cesium, meters). null = not yet queried. */
  cesiumTerrainHeight: number | null;
  /** Human-readable source label for the sampled terrain height. */
  cesiumTerrainSource: string | null;
  /** Model ID that the Cesium overlay is currently displaying. */
  cesiumSourceModelId: string | null;
  /** Terrain clip Y position in viewer space. When set, fragments below this Y are discarded. */
  cesiumTerrainClipY: number | null;
  /** Whether the GLB model has been loaded into Cesium (hides WebGPU overlay). */
  cesiumGlbLoaded: boolean;
  /** Whether the direct placement editor is active. */
  cesiumPlacementEditMode: boolean;
  /** Source model currently associated with the placement draft. */
  cesiumPlacementDraftModelId: string | null;
  /** Preview placement values shown in Cesium before applying to IFC georeference. */
  cesiumPlacementDraft: CesiumPlacementDraft | null;

  // Actions
  setCesiumAvailable: (available: boolean) => void;
  setCesiumEnabled: (enabled: boolean) => void;
  toggleCesium: () => void;
  setCesiumDataSource: (source: CesiumDataSource) => void;
  setCesiumIonToken: (token: string) => void;
  setCesiumTerrainEnabled: (enabled: boolean) => void;
  setCesiumTerrainHeight: (height: number | null) => void;
  setCesiumTerrainSource: (source: string | null) => void;
  setCesiumSourceModelId: (modelId: string | null) => void;
  setCesiumTerrainClipY: (y: number | null) => void;
  setCesiumGlbLoaded: (loaded: boolean) => void;
  setCesiumPlacementEditMode: (enabled: boolean) => void;
  toggleCesiumPlacementEditMode: () => void;
  beginCesiumPlacementDraft: (
    modelId: string,
    conversion: Pick<MapConversion, 'eastings' | 'northings' | 'orthogonalHeight' | 'xAxisAbscissa' | 'xAxisOrdinate'>,
  ) => void;
  updateCesiumPlacementDraft: (values: Partial<CesiumPlacementDraft>) => void;
  resetCesiumPlacementDraft: () => void;
}

const STORAGE_KEY_ION_TOKEN = 'ifc-lite:cesium-ion-token';
const STORAGE_KEY_DATA_SOURCE = 'ifc-lite:cesium-data-source';

/**
 * Default Cesium ion token provided at build time.
 * Set via VITE_CESIUM_ION_TOKEN in .env or CI environment.
 * This means users never need to configure a token manually.
 */
const DEFAULT_ION_TOKEN: string = (import.meta as any).env?.VITE_CESIUM_ION_TOKEN ?? '';

function loadFromStorage(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveToStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
}

function loadDataSource(): CesiumDataSource {
  // Only Google Photorealistic is supported; upgrade any stale stored value.
  return 'google-photorealistic';
}

/** Resolve the Cesium ion token: user override > build-time default */
function resolveIonToken(): string {
  const userToken = loadFromStorage(STORAGE_KEY_ION_TOKEN, '');
  return userToken || DEFAULT_ION_TOKEN;
}

/**
 * Cross-slice surface CesiumSlice writes into. `editEnabled` lives on
 * UISlice — turning on the placement editor implies global edit mode,
 * so the slice writes it directly here to keep the toolbar pill in
 * sync atomically.
 */
export interface CesiumCrossSliceState {
  editEnabled: boolean;
}

export const createCesiumSlice: StateCreator<CesiumSlice & CesiumCrossSliceState, [], [], CesiumSlice> = (set) => ({
  cesiumAvailable: false,
  cesiumEnabled: false,
  cesiumDataSource: loadDataSource(),
  cesiumIonToken: resolveIonToken(),
  cesiumTerrainEnabled: true,
  cesiumTerrainHeight: null,
  cesiumTerrainSource: null,
  cesiumSourceModelId: null,
  cesiumTerrainClipY: null,
  cesiumGlbLoaded: false,
  cesiumPlacementEditMode: false,
  cesiumPlacementDraftModelId: null,
  cesiumPlacementDraft: null,

  setCesiumAvailable: (available) => set({ cesiumAvailable: available }),
  setCesiumEnabled: (enabled) => set({ cesiumEnabled: enabled }),
  toggleCesium: () => set((s) => ({
    cesiumEnabled: !s.cesiumEnabled,
    ...(s.cesiumEnabled
      ? {
          cesiumPlacementEditMode: false,
          cesiumPlacementDraftModelId: null,
          cesiumPlacementDraft: null,
        }
      : {}),
  })),
  setCesiumDataSource: (source) => {
    clearTerrainElevationCache();
    saveToStorage(STORAGE_KEY_DATA_SOURCE, source);
    set({
      cesiumDataSource: source,
      cesiumTerrainHeight: null,
      cesiumTerrainSource: null,
      cesiumTerrainClipY: null,
    });
  },
  setCesiumIonToken: (token) => {
    clearTerrainElevationCache();
    saveToStorage(STORAGE_KEY_ION_TOKEN, token);
    set({
      cesiumIonToken: token || DEFAULT_ION_TOKEN,
      cesiumTerrainHeight: null,
      cesiumTerrainSource: null,
      cesiumTerrainClipY: null,
    });
  },
  setCesiumTerrainEnabled: (enabled) => {
    clearTerrainElevationCache();
    set({
      cesiumTerrainEnabled: enabled,
      cesiumTerrainHeight: null,
      cesiumTerrainSource: null,
      cesiumTerrainClipY: null,
    });
  },
  setCesiumTerrainHeight: (height) => set({ cesiumTerrainHeight: height }),
  setCesiumTerrainSource: (source) => set({ cesiumTerrainSource: source }),
  setCesiumSourceModelId: (modelId) => set({ cesiumSourceModelId: modelId }),
  setCesiumTerrainClipY: (y) => set({ cesiumTerrainClipY: y }),
  setCesiumGlbLoaded: (loaded) => set({ cesiumGlbLoaded: loaded }),
  setCesiumPlacementEditMode: (enabled) => set(
    // Turning the placement editor on implies global edit mode — keeps
    // the toolbar pill in sync so the user can't end up "moving the
    // georef" while the rest of the UI claims it's read-only. Turning
    // it off does *not* exit global edit; other sub-tools (properties,
    // geometry) may still be in use — but we DO clear the placement
    // draft so callers exiting via the setter don't leave stale draft
    // state behind (matches the toggle's disable branch).
    enabled
      ? { cesiumPlacementEditMode: true, editEnabled: true }
      : {
          cesiumPlacementEditMode: false,
          cesiumPlacementDraftModelId: null,
          cesiumPlacementDraft: null,
        },
  ),
  toggleCesiumPlacementEditMode: () => set((s) => (
    s.cesiumPlacementEditMode
      ? {
          cesiumPlacementEditMode: false,
          cesiumPlacementDraftModelId: null,
          cesiumPlacementDraft: null,
        }
      : { cesiumPlacementEditMode: true, editEnabled: true }
  )),
  beginCesiumPlacementDraft: (modelId, conversion) => set({
    cesiumPlacementDraftModelId: modelId,
    cesiumPlacementDraft: {
      eastings: conversion.eastings,
      northings: conversion.northings,
      orthogonalHeight: conversion.orthogonalHeight,
      // IFC MapConversion's x-axis cos/sin pair is optional in the schema.
      // When absent, the convention is "no rotation": cos=1, sin=0.
      xAxisAbscissa: conversion.xAxisAbscissa ?? 1,
      xAxisOrdinate: conversion.xAxisOrdinate ?? 0,
    },
  }),
  updateCesiumPlacementDraft: (values) => set((state) => ({
    cesiumPlacementDraft: state.cesiumPlacementDraft
      ? { ...state.cesiumPlacementDraft, ...values }
      : null,
  })),
  resetCesiumPlacementDraft: () => set({
    cesiumPlacementDraftModelId: null,
    cesiumPlacementDraft: null,
  }),
});
