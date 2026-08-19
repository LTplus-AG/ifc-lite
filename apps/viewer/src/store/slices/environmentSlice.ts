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
  /**
   * Light hardness trim. 1 = neutral. Above 1 deepens shadows by dividing the
   * preset's hemisphere ambient + fill (more sun-vs-ambient contrast); below 1
   * flattens the light. Composed onto the preset in Viewport.
   */
  envHardness: number;
  /**
   * Terminator-softness trim, multiplied onto the preset's `sunSoftness`.
   * 1 = neutral. Below 1 crisps the light/shadow boundary (harder shadows),
   * above 1 softens it. The renderer clamps the product to [0, 1].
   */
  envSoftness: number;
  /** Whether the Sun & Sky panel is open. */
  envPanelOpen: boolean;

  /**
   * Sun cast shadows (#2670). Off by default — an extra depth pre-pass, so it
   * is opt-in until a device is known to handle it. Persisted per device.
   */
  envShadowsEnabled: boolean;
  /**
   * Sun angular size in degrees — the physical control on shadow-edge softness
   * (Blender's Sun lamp `Angle`, ~0.53° for a clear sky). Larger = wider
   * penumbra / softer shadows. Describes the LIGHT, so it persists with the
   * lighting choices. Clamped to [0.1, 5].
   */
  envSunAngle: number;
  /**
   * Shadow-map resolution (square side, texels). A pure cost-vs-fidelity dial
   * (the machine, not the light), so it lives here as a Quality control and
   * persists per device. One of 1024 / 2048 / 4096.
   */
  envShadowResolution: number;

  setEnvPreset: (preset: LightingPresetId) => void;
  setEnvSkyEnabled: (enabled: boolean) => void;
  setEnvExposure: (exposure: number) => void;
  setEnvHardness: (hardness: number) => void;
  setEnvSoftness: (softness: number) => void;
  setEnvPanelOpen: (open: boolean) => void;
  toggleEnvPanel: () => void;
  setEnvShadowsEnabled: (enabled: boolean) => void;
  setEnvSunAngle: (deg: number) => void;
  setEnvShadowResolution: (resolution: number) => void;
}

const STORAGE_KEY = 'ifc-lite:environment';

interface PersistedEnvironment {
  preset?: string;
  skyEnabled?: boolean;
  exposure?: number;
  hardness?: number;
  softness?: number;
  shadowsEnabled?: boolean;
  sunAngle?: number;
  shadowResolution?: number;
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

function persist(state: Pick<EnvironmentSlice, 'envPreset' | 'envSkyEnabled' | 'envExposure' | 'envHardness' | 'envSoftness' | 'envShadowsEnabled' | 'envSunAngle' | 'envShadowResolution'>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      preset: state.envPreset,
      skyEnabled: state.envSkyEnabled,
      exposure: state.envExposure,
      hardness: state.envHardness,
      softness: state.envSoftness,
      shadowsEnabled: state.envShadowsEnabled,
      sunAngle: state.envSunAngle,
      shadowResolution: state.envShadowResolution,
    } satisfies PersistedEnvironment));
  } catch { /* storage unavailable */ }
}

function clampExposure(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(2, Math.max(0.4, value));
}

function clampHardness(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(2, Math.max(0.5, value));
}

function clampSoftness(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(2, Math.max(0, value));
}

function clampSunAngle(value: number): number {
  if (!Number.isFinite(value)) return 0.53;
  return Math.min(5, Math.max(0.1, value));
}

/** Snap to one of the supported shadow-map sizes. */
function clampShadowResolution(value: number): number {
  const allowed = [1024, 2048, 4096];
  if (!Number.isFinite(value)) return 2048;
  return allowed.includes(value) ? value : 2048;
}

export const createEnvironmentSlice: StateCreator<EnvironmentSlice, [], [], EnvironmentSlice> = (set, get) => {
  const stored = loadPersisted();
  const initial = {
    envPreset: (stored.preset && isLightingPresetId(stored.preset) ? stored.preset : 'default') as LightingPresetId,
    envSkyEnabled: stored.skyEnabled === true,
    envExposure: clampExposure(stored.exposure ?? 1),
    envHardness: clampHardness(stored.hardness ?? 1),
    envSoftness: clampSoftness(stored.softness ?? 1),
    envShadowsEnabled: stored.shadowsEnabled === true,
    envSunAngle: clampSunAngle(stored.sunAngle ?? 0.53),
    envShadowResolution: clampShadowResolution(stored.shadowResolution ?? 2048),
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
    setEnvHardness: (hardness) => update({ envHardness: clampHardness(hardness) }),
    setEnvSoftness: (softness) => update({ envSoftness: clampSoftness(softness) }),
    setEnvPanelOpen: (open) => set({ envPanelOpen: open }),
    toggleEnvPanel: () => set((s) => ({ envPanelOpen: !s.envPanelOpen })),
    setEnvShadowsEnabled: (enabled) => update({ envShadowsEnabled: enabled }),
    setEnvSunAngle: (deg) => update({ envSunAngle: clampSunAngle(deg) }),
    setEnvShadowResolution: (resolution) => update({ envShadowResolution: clampShadowResolution(resolution) }),
  };
};
