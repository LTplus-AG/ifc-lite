/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StateCreator } from 'zustand';
import type { SavedComparison } from '@/lib/compare/savedComparisons';
import { loadSavedComparisons, persistSavedComparisons } from '@/lib/compare/savedComparisonPersistence';

/** Saved reports survive model teardown; their rows contain no live renderer references. */
export interface SavedComparisonsSlice {
  savedComparisons: SavedComparison[];
  saveComparison: (comparison: SavedComparison) => boolean;
  renameSavedComparison: (id: string, name: string) => boolean;
  deleteSavedComparison: (id: string) => boolean;
}

export const createSavedComparisonsSlice: StateCreator<SavedComparisonsSlice, [], [], SavedComparisonsSlice> = (set, get) => {
  const update = (savedComparisons: SavedComparison[]): boolean => {
    set({ savedComparisons });
    return persistSavedComparisons(savedComparisons);
  };
  return {
    savedComparisons: loadSavedComparisons(),
    saveComparison: (comparison) => update([...get().savedComparisons, structuredClone(comparison)]),
    renameSavedComparison: (id, name) => name.trim() ? update(get().savedComparisons.map((c) => c.id === id ? { ...c, name: name.trim() } : c)) : false,
    deleteSavedComparison: (id) => update(get().savedComparisons.filter((c) => c.id !== id)),
  };
};
