/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Persisted bits of the bottom-strip header (#5498): the strip's resize
 * height and the tabs a user has opened, so both survive a reload. Plain
 * localStorage IO, the same shape as `dockSlice`'s floating-panel layout —
 * this is `BottomStrip`-local UI state, not shared with the rest of the
 * store, so it does not need a slice of its own.
 */

import { isBottomPanel, type BottomPanelId } from './bottom-panels';

const TABS_STORAGE_KEY = 'ifc-lite:bottom-strip-tabs-v1';
const HEIGHT_STORAGE_KEY = 'ifc-lite:bottom-strip-height-v1';
const ORIENTATION_STORAGE_KEY = 'ifc-lite:bottom-strip-orientation-v1';

/** Where the strip docks: below the viewport (default) or beside it — the
 *  side-by-side 2D/3D layout preset (#5515). Persisted regardless of which
 *  panel is active when the user picks it; `ViewerLayout` decides whether
 *  the CURRENT panel (only `drawing`) actually honours it. */
export type BottomStripOrientation = 'bottom' | 'side';

export const BOTTOM_STRIP_MIN_HEIGHT = 120;
export const BOTTOM_STRIP_DEFAULT_HEIGHT = 300;
/** Max resize height, as a ratio of the layout container (#1208's cap). */
export const BOTTOM_STRIP_MAX_RATIO = 0.7;

/** The persisted tab order, filtered to ids the current build still knows —
 *  a retired panel id or a corrupt entry is dropped rather than crashing. */
export function loadBottomStripTabs(): BottomPanelId[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(TABS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<BottomPanelId>();
    const out: BottomPanelId[] = [];
    for (const entry of parsed) {
      if (typeof entry === 'string' && isBottomPanel(entry) && !seen.has(entry)) {
        seen.add(entry);
        out.push(entry);
      }
    }
    return out;
  } catch (error) {
    console.warn('[bottom-strip] ignoring malformed persisted tabs:', error);
    return [];
  }
}

export function persistBottomStripTabs(tabs: readonly BottomPanelId[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(tabs));
  } catch (error) {
    console.warn('[bottom-strip] failed to persist tabs:', error);
  }
}

export function loadBottomStripHeight(): number {
  if (typeof window === 'undefined') return BOTTOM_STRIP_DEFAULT_HEIGHT;
  try {
    const raw = window.localStorage.getItem(HEIGHT_STORAGE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed >= BOTTOM_STRIP_MIN_HEIGHT ? parsed : BOTTOM_STRIP_DEFAULT_HEIGHT;
  } catch (error) {
    console.warn('[bottom-strip] ignoring malformed persisted height:', error);
    return BOTTOM_STRIP_DEFAULT_HEIGHT;
  }
}

export function persistBottomStripHeight(height: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(height));
  } catch (error) {
    console.warn('[bottom-strip] failed to persist height:', error);
  }
}

export function loadBottomStripOrientation(): BottomStripOrientation {
  if (typeof window === 'undefined') return 'bottom';
  try {
    return window.localStorage.getItem(ORIENTATION_STORAGE_KEY) === 'side' ? 'side' : 'bottom';
  } catch (error) {
    console.warn('[bottom-strip] ignoring malformed persisted orientation:', error);
    return 'bottom';
  }
}

export function persistBottomStripOrientation(orientation: BottomStripOrientation): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ORIENTATION_STORAGE_KEY, orientation);
  } catch (error) {
    console.warn('[bottom-strip] failed to persist orientation:', error);
  }
}
