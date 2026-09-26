/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { HIERARCHY_MODE_STORAGE_KEY } from '../constants.js';
import { parseNavigationPreset, type NavigationPreset } from '@/lib/navigation/presets.js';
import type { HierarchyMode } from './uiSlice.js';

const NAVIGATION_PRESET_STORAGE_KEY = 'ifc-lite-navigation-preset';

export function getInitialHierarchyMode(): HierarchyMode {
  if (typeof window === 'undefined') return 'spatial';
  try {
    const stored = localStorage.getItem(HIERARCHY_MODE_STORAGE_KEY);
    if (stored === 'spatial' || stored === 'type' || stored === 'ifc-type' || stored === 'material' || stored === 'groups') {
      return stored;
    }
  } catch (err) {
    console.warn('[hierarchy-mode] storage unavailable; using spatial', err);
  }
  return 'spatial';
}

export function getInitialNavigationPreset(): NavigationPreset {
  if (typeof window === 'undefined') return 'default';
  try {
    return parseNavigationPreset(localStorage.getItem(NAVIGATION_PRESET_STORAGE_KEY));
  } catch (err) {
    console.warn('[navigation-preset] storage unavailable; using default', err);
    return 'default';
  }
}

export function persistHierarchyMode(mode: HierarchyMode): void {
  try {
    localStorage.setItem(HIERARCHY_MODE_STORAGE_KEY, mode);
  } catch (err) {
    console.warn('[hierarchy-mode] persist failed; in-memory only', err);
  }
}

export function persistNavigationPreset(preset: NavigationPreset): void {
  try {
    localStorage.setItem(NAVIGATION_PRESET_STORAGE_KEY, preset);
  } catch (err) {
    console.warn('[navigation-preset] persist failed; in-memory only', err);
  }
}
