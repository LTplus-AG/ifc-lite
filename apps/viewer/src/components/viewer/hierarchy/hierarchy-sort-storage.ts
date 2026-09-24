/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { HierarchySortMode } from './types';
import { HIERARCHY_SORT_MODES, DEFAULT_HIERARCHY_SORT } from './types';

const SORT_STORAGE_KEY = 'hierarchy-sort';

/** Private mode and opaque origins may reject localStorage access. */
export function readStoredSortMode(): HierarchySortMode {
  if (typeof window === 'undefined') return DEFAULT_HIERARCHY_SORT;
  try {
    const stored = localStorage.getItem(SORT_STORAGE_KEY);
    return stored && (HIERARCHY_SORT_MODES as readonly string[]).includes(stored)
      ? (stored as HierarchySortMode)
      : DEFAULT_HIERARCHY_SORT;
  } catch (error) {
    console.warn('[hierarchy-sort] Could not read saved sort mode', error);
    return DEFAULT_HIERARCHY_SORT;
  }
}

export function persistSortMode(mode: HierarchySortMode): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SORT_STORAGE_KEY, mode);
  } catch (error) {
    console.warn('[hierarchy-sort] Could not save sort mode', error);
  }
}
