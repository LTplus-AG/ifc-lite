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

export type CesiumDataSource =
  | 'osm-buildings'        // Cesium OSM Buildings (free via Cesium ion)
  | 'bing-aerial'          // Bing Maps aerial imagery draped on terrain
  | 'google-photorealistic'; // Google Photorealistic 3D Tiles (requires API key)

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
  /** Clamp model to terrain height at its geodetic position. */
  cesiumTerrainClamp: boolean;
  /** Terrain height at model position (queried from Cesium, meters). null = not yet queried. */
  cesiumTerrainHeight: number | null;
  /** Model ID that the Cesium overlay is currently displaying. */
  cesiumSourceModelId: string | null;
  /** Terrain clip Y position in viewer space. When set, fragments below this Y are discarded. */
  cesiumTerrainClipY: number | null;
  /** Whether the GLB model has been loaded into Cesium (hides WebGPU overlay). */
  cesiumGlbLoaded: boolean;

  // Actions
  setCesiumAvailable: (available: boolean) => void;
  setCesiumEnabled: (enabled: boolean) => void;
  toggleCesium: () => void;
  setCesiumDataSource: (source: CesiumDataSource) => void;
  setCesiumIonToken: (token: string) => void;
  setCesiumTerrainEnabled: (enabled: boolean) => void;
  setCesiumTerrainClamp: (clamp: boolean) => void;
  setCesiumTerrainHeight: (height: number | null) => void;
  setCesiumSourceModelId: (modelId: string | null) => void;
  setCesiumTerrainClipY: (y: number | null) => void;
  setCesiumGlbLoaded: (loaded: boolean) => void;
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

const VALID_DATA_SOURCES = new Set<CesiumDataSource>(['osm-buildings', 'bing-aerial', 'google-photorealistic']);

function loadDataSource(): CesiumDataSource {
  const stored = loadFromStorage(STORAGE_KEY_DATA_SOURCE, '');
  return VALID_DATA_SOURCES.has(stored as CesiumDataSource)
    ? (stored as CesiumDataSource)
    : 'google-photorealistic';
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
  cesiumTerrainClamp: true,
  cesiumTerrainHeight: null,
  cesiumSourceModelId: null,
  cesiumTerrainClipY: null,
  cesiumGlbLoaded: false,

  setCesiumAvailable: (available) => set({ cesiumAvailable: available }),
  setCesiumEnabled: (enabled) => set({ cesiumEnabled: enabled }),
  toggleCesium: () => set((s) => ({ cesiumEnabled: !s.cesiumEnabled })),
  setCesiumDataSource: (source) => {
    saveToStorage(STORAGE_KEY_DATA_SOURCE, source);
    set({ cesiumDataSource: source });
  },
  setCesiumIonToken: (token) => {
    saveToStorage(STORAGE_KEY_ION_TOKEN, token);
    set({ cesiumIonToken: token || DEFAULT_ION_TOKEN });
  },
  setCesiumTerrainEnabled: (enabled) => set({ cesiumTerrainEnabled: enabled }),
  setCesiumTerrainClamp: (clamp) => set({ cesiumTerrainClamp: clamp }),
  setCesiumTerrainHeight: (height) => set({ cesiumTerrainHeight: height }),
  setCesiumSourceModelId: (modelId) => set({ cesiumSourceModelId: modelId }),
  setCesiumTerrainClipY: (y) => set({ cesiumTerrainClipY: y }),
  setCesiumGlbLoaded: (loaded) => set({ cesiumGlbLoaded: loaded }),
});
