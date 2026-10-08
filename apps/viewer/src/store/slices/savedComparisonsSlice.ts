/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StateCreator } from 'zustand';
import { isSavedComparison, type SavedComparison } from '@/lib/compare/savedComparisons';
import { sameReportEvidence } from '@/lib/flow/report-provenance';
import { comparisonContent } from '@/lib/compare/savedComparisonPersistence';
import type { ContentCommitReceipt } from '@/lib/storage/content-library';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '@/lib/storage/content-library';

export interface SavedComparisonsSlice {
  savedComparisons: SavedComparison[];
  savedComparisonsStorage: ContentStatus;
  initializeSavedComparisons: () => Promise<boolean>;
  refreshSavedComparisons: (committed?: readonly ContentCommitReceipt[]) => Promise<boolean>;
  restoreSavedComparisons: () => Promise<boolean>;
  retrySaveComparisons: () => Promise<boolean>;
  saveComparison: (comparison: SavedComparison) => Promise<boolean>;
  stageComparison: (comparison: SavedComparison) => void;
  renameSavedComparison: (id: string, name: string) => Promise<boolean>;
  deleteSavedComparison: (id: string, beforeWrite?: () => boolean) => Promise<boolean>;
}

export const createSavedComparisonsSlice: StateCreator<SavedComparisonsSlice, [], [], SavedComparisonsSlice> = (set, get) => {
  const library = createContentLibrary(comparisonContent, () => get().savedComparisons, (entries, status) => set({
    savedComparisons: entries, savedComparisonsStorage: status,
  }));
  return {
    savedComparisons: [], savedComparisonsStorage: initialContentStatus(),
    initializeSavedComparisons: library.initialize, refreshSavedComparisons: library.refresh,
    restoreSavedComparisons: library.restore,
    retrySaveComparisons: library.retry,
    stageComparison: entry => { if (isSavedComparison(entry)) library.stage(entry.id, entry); },
    saveComparison: comparison => {
      if (!isSavedComparison(comparison)) { console.warn('[Comparisons] Refusing invalid evidence'); return Promise.resolve(false); }
      const existing = get().savedComparisons.find(entry => entry.id === comparison.id);
      if (existing && !sameReportEvidence({ ...existing, name: comparison.name }, comparison)) {
        console.warn('[Comparisons] Refusing conflicting evidence ID', comparison.id); return Promise.resolve(false);
      }
      return library.put(comparison.id, comparison);
    },
    renameSavedComparison: (id, name) => {
      const entry = get().savedComparisons.find(value => value.id === id);
      return entry && name.trim() ? library.put(id, { ...entry, name: name.trim() }) : Promise.resolve(false);
    },
    deleteSavedComparison: (id, beforeWrite) => library.put(id, null, beforeWrite),
  };
};
