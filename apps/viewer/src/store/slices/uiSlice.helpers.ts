/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Small UI-slice helpers kept separate from the already budgeted state module. */

import type { ThemeMode, UICrossSliceState } from './uiSlice.js';
import type { PointerInput } from '../types.js';

const PERFORMANCE_STATS_KEY = 'ifc-lite:show-performance-stats';

/**
 * The input to assume before the viewport has seen any (#8879): touch when
 * the primary pointer is coarse (a phone or tablet), else mouse. Only a seed:
 * the last input actually used replaces it, so a hybrid device follows use.
 */
export function initialPointerInput(media: ((query: string) => { matches: boolean }) | undefined =
  typeof matchMedia === 'function' ? (query) => matchMedia(query) : undefined): PointerInput {
  try {
    return media?.('(pointer: coarse)').matches ? 'touch' : 'mouse';
  } catch {
    return 'mouse';
  }
}

/** Restore the opt-in diagnostic setting; unavailable storage means off. */
export function initialShowPerformanceStats(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(PERFORMANCE_STATS_KEY) === 'true';
  } catch (error) {
    console.warn('[performance-stats] storage unavailable; using off', error);
    return false;
  }
}

/** Persist the user choice without losing the in-memory toggle if storage fails. */
export function persistShowPerformanceStats(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PERFORMANCE_STATS_KEY, String(enabled));
  } catch (error) {
    console.warn('[performance-stats] could not persist setting', error);
  }
}

/** Apply the correct CSS classes on <html> for the given theme. */
export function applyThemeClasses(theme: ThemeMode): void {
  const el = document.documentElement;
  el.classList.toggle('dark', theme === 'dark');
  el.classList.toggle('colorful', theme === 'colorful');
}

/** Whether a federated or legacy model has geometry. */
export function hasLoadedModel(state: Pick<UICrossSliceState, 'models' | 'geometryResult'>): boolean {
  if (state.models.size > 0) return true;
  return (state.geometryResult?.meshes.length ?? 0) > 0;
}
