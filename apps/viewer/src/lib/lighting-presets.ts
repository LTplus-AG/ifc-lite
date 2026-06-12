/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lighting presets for the WebGPU viewport.
 *
 * Each preset is a partial `LightingEnvironment`; unset fields fall back to
 * the renderer defaults (the historical hardcoded look). The `default`
 * preset is intentionally empty so it renders pixel-identical to every
 * ifc-lite build before lighting became configurable.
 *
 * When the solar study drives the sun, the preset still supplies the base
 * sun intensity and hemisphere colours; only direction/colour/fades are
 * overridden per the computed sun altitude.
 */

import type { LightingEnvironment } from '@ifc-lite/renderer';

export type LightingPresetId = 'default' | 'daylight' | 'overcast' | 'golden' | 'night';

export interface LightingPreset {
  id: LightingPresetId;
  label: string;
  hint: string;
  environment: LightingEnvironment;
}

export const LIGHTING_PRESETS: Record<LightingPresetId, LightingPreset> = {
  default: {
    id: 'default',
    label: 'Default',
    hint: 'The classic ifc-lite studio look',
    environment: {},
  },
  daylight: {
    id: 'daylight',
    label: 'Day',
    hint: 'Bright neutral daylight, high sun',
    environment: {
      sunDirection: [0.45, 0.83, 0.33],
      sunColor: [1.0, 0.98, 0.92],
      sunIntensity: 0.62,
      skyColor: [0.42, 0.52, 0.65],
      groundColor: [0.22, 0.19, 0.15],
      ambientIntensity: 0.3,
      exposure: 0.9,
    },
  },
  overcast: {
    id: 'overcast',
    label: 'Overcast',
    hint: 'Soft shadowless grey-sky light',
    environment: {
      sunDirection: [0.2, 0.95, 0.24],
      sunColor: [0.9, 0.92, 0.95],
      sunIntensity: 0.28,
      skyColor: [0.55, 0.57, 0.6],
      groundColor: [0.28, 0.28, 0.28],
      ambientIntensity: 0.45,
      fillIntensity: 0.1,
      rimIntensity: 0.08,
      exposure: 0.85,
      sky: {
        zenith: [0.5, 0.54, 0.58],
        horizon: [0.66, 0.68, 0.7],
        ground: [0.2, 0.2, 0.2],
      },
    },
  },
  golden: {
    id: 'golden',
    label: 'Evening',
    hint: 'Low warm sun, golden-hour mood',
    environment: {
      sunDirection: [0.85, 0.18, 0.49],
      sunColor: [1.0, 0.72, 0.45],
      sunIntensity: 0.6,
      skyColor: [0.3, 0.26, 0.32],
      groundColor: [0.16, 0.11, 0.08],
      ambientIntensity: 0.22,
      exposure: 0.82,
    },
  },
  night: {
    id: 'night',
    label: 'Night',
    hint: 'Cool moonlit ambience',
    environment: {
      sunDirection: [-0.3, 0.7, -0.65],
      sunColor: [0.65, 0.72, 0.9],
      sunIntensity: 0.18,
      skyColor: [0.1, 0.12, 0.2],
      groundColor: [0.05, 0.05, 0.07],
      ambientIntensity: 0.3,
      fillIntensity: 0.08,
      rimIntensity: 0.2,
      exposure: 0.75,
    },
  },
};

export const LIGHTING_PRESET_ORDER: LightingPresetId[] = [
  'default',
  'daylight',
  'overcast',
  'golden',
  'night',
];

export function isLightingPresetId(value: string): value is LightingPresetId {
  return value in LIGHTING_PRESETS;
}
