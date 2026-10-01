/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SavedHistoryIssue } from '@/lib/storage/saved-history';
import type { StateCreator } from 'zustand';
import { isSavedComparison, type SavedComparison } from '@/lib/compare/savedComparisons';
import { sameReportEvidence } from '@/lib/flow/report-provenance';
import { readSavedComparisons, saveSavedComparisons } from '@/lib/compare/savedComparisonPersistence';

/** Saved reports survive model teardown; their rows contain no live renderer references. */
export interface SavedComparisonsSlice {
  savedComparisons: SavedComparison[];
  savedComparisonsLoadIssue: SavedHistoryIssue | null;
  retrySaveComparisons: () => boolean;
  saveComparison: (comparison: SavedComparison) => boolean;
  renameSavedComparison: (id: string, name: string) => boolean;
  deleteSavedComparison: (id: string) => boolean;
}

export const createSavedComparisonsSlice: StateCreator<SavedComparisonsSlice, [], [], SavedComparisonsSlice> = (set, get) => {
  const update = (savedComparisons: SavedComparison[]): boolean => {
    set({ savedComparisons });
    const outcome = saveSavedComparisons(savedComparisons);
    set({ savedComparisons: outcome.entries, savedComparisonsLoadIssue: outcome.issue });
    return outcome.ok;
  };
  const loaded = readSavedComparisons();
  return {
    savedComparisons: loaded.entries,
    savedComparisonsLoadIssue: loaded.issue,
    retrySaveComparisons: () => update(get().savedComparisons),
    saveComparison: (comparison) => {
      if (!isSavedComparison(comparison)) { console.warn('[Comparisons] Refusing invalid saved evidence'); return false; }
      const current = get().savedComparisons;
      const existing = current.find((entry) => entry.id === comparison.id);
      if (existing && !sameReportEvidence(existing, comparison)) {
        console.warn('[Comparisons] Refusing conflicting evidence ID', comparison.id);
        return false;
      }
      return update(existing ? current : [...current, structuredClone(comparison)]);
    },
    renameSavedComparison: (id, name) => name.trim() ? update(get().savedComparisons.map((c) => c.id === id ? { ...c, name: name.trim() } : c)) : false,
    deleteSavedComparison: (id) => update(get().savedComparisons.filter((c) => c.id !== id)),
  };
};
