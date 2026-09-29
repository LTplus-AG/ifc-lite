/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { isSavedComparison, type SavedComparison } from './savedComparisonSchema';
export const SAVED_COMPARISONS_KEY = 'ifc-lite-saved-comparisons';

export function loadSavedComparisons(): SavedComparison[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SAVED_COMPARISONS_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    return raw.filter((entry: unknown): entry is SavedComparison => {
      if (!isSavedComparison(entry) || seen.has(entry.id)) {
        console.warn('[Compare] Dropping invalid or duplicate saved comparison');
        return false;
      }
      seen.add(entry.id);
      return true;
    });
  } catch (error) {
    console.warn('[Compare] Failed to load saved comparisons', error);
    return [];
  }
}

export function persistSavedComparisons(entries: readonly SavedComparison[]): boolean {
  try {
    localStorage.setItem(SAVED_COMPARISONS_KEY, JSON.stringify(entries));
    return true;
  } catch (error) {
    console.warn('[Compare] Failed to persist saved comparisons', error);
    return false;
  }
}
