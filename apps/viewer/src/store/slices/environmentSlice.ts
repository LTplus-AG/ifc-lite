/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Environment (sky + lighting) state slice.
 *
 * Owns the user's lighting choices for BOTH rendering paths:
 *   • WebGPU viewport — preset lighting + procedural sky pass, composed into
 *     `RenderOptions.environment` by Viewport.
 *   • Cesium geo mode — the same sky toggle drives `scene.skyAtmosphere` /
 *     `scene.sun` / fog in CesiumOverlay, so "Sky" means the same thing in
 *     whichever mode is active.
 *
 * Preset/sky/exposure choices persist in localStorage; panel visibility is
 * session-only.
 */

import type { StateCreator } from 'zustand';
import { isLightingPresetId, type LightingPresetId } from '@/lib/lighting-presets';

export interface EnvironmentSlice {
  /** Active lighting preset for the WebGPU viewport. */
  envPreset: LightingPresetId;
  /**
   * Cesium geo mode: show the atmosphere, sun disc and fog. (Standalone the
   * sky comes with the lighting preset — every preset except `default`
   * enables it — so this flag only drives the world-context scene.)
   */
  envSkyEnabled: boolean;
  /** User exposure trim, multiplied onto the preset exposure. 1 = neutral. */
  envExposure: number;
  /** Whether the Sun & Sky panel is open. */
  envPanelOpen: boolean;

  setEnvPreset: (preset: LightingPresetId) => void;
  setEnvSkyEnabled: (enabled: boolean) => void;
  setEnvExposure: (exposure: number) => void;
  setEnvPanelOpen: (open: boolean) => void;
  toggleEnvPanel: () => void;
}

const STORAGE_KEY = 'ifc-lite:environment';

interface PersistedEnvironment {
  preset?: string;
  skyEnabled?: boolean;
  exposure?: number;
}

function loadPersisted(): PersistedEnvironment {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as PersistedEnvironment) : {};
  } catch {
    return {};
  }
}

function persist(state: Pick<EnvironmentSlice, 'envPreset' | 'envSkyEnabled' | 'envExposure'>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      preset: state.envPreset,
      skyEnabled: state.envSkyEnabled,
      exposure: state.envExposure,
    } satisfies PersistedEnvironment));
  } catch { /* storage unavailable */ }
}

function clampExposure(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(2, Math.max(0.4, value));
}

export const createEnvironmentSlice: StateCreator<EnvironmentSlice, [], [], EnvironmentSlice> = (set, get) => {
  const stored = loadPersisted();
  const initial = {
    envPreset: (stored.preset && isLightingPresetId(stored.preset) ? stored.preset : 'default') as LightingPresetId,
    envSkyEnabled: stored.skyEnabled === true,
    envExposure: clampExposure(stored.exposure ?? 1),
  };

  const update = (patch: Partial<EnvironmentSlice>) => {
    set(patch);
    const s = get();
    persist(s);
  };

  return {
    ...initial,
    envPanelOpen: false,

    setEnvPreset: (preset) => update({ envPreset: preset }),
    setEnvSkyEnabled: (enabled) => update({ envSkyEnabled: enabled }),
    setEnvExposure: (exposure) => update({ envExposure: clampExposure(exposure) }),
    setEnvPanelOpen: (open) => set({ envPanelOpen: open }),
    toggleEnvPanel: () => set((s) => ({ envPanelOpen: !s.envPanelOpen })),
  };
};
