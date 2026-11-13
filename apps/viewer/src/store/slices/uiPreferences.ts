/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { HIERARCHY_MODE_STORAGE_KEY } from '../constants.js';
import { parseNavigationPreset, type NavigationPreset } from '@/lib/navigation/presets.js';
import { parseWheelZoomSensitivity, type WheelZoomSensitivity } from '@/lib/navigation/wheel-input.js';
import type { HierarchyMode } from './uiSlice.js';

const NAVIGATION_PRESET_STORAGE_KEY = 'ifc-lite-navigation-preset';
const WHEEL_ZOOM_SENSITIVITY_STORAGE_KEY = 'ifc-lite-wheel-zoom-sensitivity';

/** A saved choice, parsed; `fallback` when there is no window or storage throws. */
function readPreference<T>(key: string, parse: (value: string | null) => T, fallback: T, tag: string): T {
  if (typeof window === 'undefined') return fallback;
  try {
    return parse(localStorage.getItem(key));
  } catch (err) {
    console.warn(`[${tag}] storage unavailable; using ${String(fallback)}`, err);
    return fallback;
  }
}

function writePreference(key: string, value: string, tag: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    console.warn(`[${tag}] persist failed; in-memory only`, err);
  }
}

export function getInitialHierarchyMode(): HierarchyMode {
  if (typeof window === 'undefined') return 'spatial';
  try {
    const stored = localStorage.getItem(HIERARCHY_MODE_STORAGE_KEY);
    if (stored === 'spatial' || stored === 'type' || stored === 'ifc-type' || stored === 'material' || stored === 'groups' || stored === 'presentation-layers') {
      return stored;
    }
  } catch (err) {
    console.warn('[hierarchy-mode] storage unavailable; using spatial', err);
  }
  return 'spatial';
}

export function getInitialNavigationPreset(): NavigationPreset {
  return readPreference(NAVIGATION_PRESET_STORAGE_KEY, parseNavigationPreset, 'default', 'navigation-preset');
}

export function getInitialWheelZoomSensitivity(): WheelZoomSensitivity {
  return readPreference(WHEEL_ZOOM_SENSITIVITY_STORAGE_KEY, parseWheelZoomSensitivity, 'normal', 'wheel-zoom-sensitivity');
}

export function persistHierarchyMode(mode: HierarchyMode): void {
  try {
    localStorage.setItem(HIERARCHY_MODE_STORAGE_KEY, mode);
  } catch (err) {
    console.warn('[hierarchy-mode] persist failed; in-memory only', err);
  }
}

export function persistNavigationPreset(preset: NavigationPreset): void {
  writePreference(NAVIGATION_PRESET_STORAGE_KEY, preset, 'navigation-preset');
}

export function persistWheelZoomSensitivity(sensitivity: WheelZoomSensitivity): void {
  writePreference(WHEEL_ZOOM_SENSITIVITY_STORAGE_KEY, sensitivity, 'wheel-zoom-sensitivity');
}
