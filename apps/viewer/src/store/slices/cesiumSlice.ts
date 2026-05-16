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
  /**
   * User-selected federation anchor model.
   *
   * When multiple georeferenced models are loaded, federation alignment rebakes
   * every other model's geometry into this model's viewer-space frame so they
   * land in the right relative real-world positions. The Cesium bridge also
   * uses this model's IfcMapConversion to anchor the viewer→ECEF transform.
   *
   * `null` selects the default anchor (earliest `loadedAt` with a valid georef).
   * Setting an override fires a `RECOMPUTE_FEDERATION_ALIGNMENT` re-bake.
   */
  anchorModelIdOverride: string | null;
  /**
   * When true, the viewport renders a small XYZ triad + label at each loaded
   * model's true IFC (0,0,0) point — useful for debugging federation
   * alignment. Origin positions are derived from each model's IfcMapConversion
   * and the anchor's MapConversion, so the markers stay correct after re-aligns
   * and across cross-CRS reprojections.
   */
  showModelBasepoints: boolean;
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
  setAnchorModelIdOverride: (modelId: string | null) => void;
  setShowModelBasepoints: (show: boolean) => void;
  toggleShowModelBasepoints: () => void;
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

export const createCesiumSlice: StateCreator<CesiumSlice, [], [], CesiumSlice> = (set) => ({
  cesiumAvailable: false,
  cesiumEnabled: false,
  cesiumDataSource: loadDataSource(),
  cesiumIonToken: resolveIonToken(),
  cesiumTerrainEnabled: true,
  cesiumTerrainHeight: null,
  cesiumTerrainSource: null,
  cesiumSourceModelId: null,
  anchorModelIdOverride: null,
  showModelBasepoints: false,
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
  setAnchorModelIdOverride: (modelId) => set({ anchorModelIdOverride: modelId }),
  setShowModelBasepoints: (show) => set({ showModelBasepoints: show }),
  toggleShowModelBasepoints: () => set((s) => ({ showModelBasepoints: !s.showModelBasepoints })),
  setCesiumTerrainClipY: (y) => set({ cesiumTerrainClipY: y }),
  setCesiumGlbLoaded: (loaded) => set({ cesiumGlbLoaded: loaded }),
  setCesiumPlacementEditMode: (enabled) => set({ cesiumPlacementEditMode: enabled }),
  toggleCesiumPlacementEditMode: () => set((s) => ({
    cesiumPlacementEditMode: !s.cesiumPlacementEditMode,
    ...(!s.cesiumPlacementEditMode
      ? {}
      : {
          cesiumPlacementDraftModelId: null,
          cesiumPlacementDraft: null,
        }),
  })),
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
