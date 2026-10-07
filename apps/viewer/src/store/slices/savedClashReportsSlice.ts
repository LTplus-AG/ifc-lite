/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StateCreator } from 'zustand';
import { isSavedClashReport, type SavedClashReport } from '@/lib/clash/saved-report-schema';
import { clashReportsContent } from '@/lib/clash/saved-report-persistence';
import { sameReportEvidence } from '@/lib/flow/report-provenance';
import type { ContentCommitReceipt } from '@/lib/storage/content-library';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '@/lib/storage/content-library';

/** Saved clash reports (#6947): the same library controller, save states and
 * immutable-evidence rule as saved comparisons. Only the name may change. */
export interface SavedClashReportsSlice {
  savedClashReports: SavedClashReport[];
  savedClashReportsStorage: ContentStatus;
  initializeSavedClashReports: () => Promise<boolean>;
  refreshSavedClashReports: (committed?: readonly ContentCommitReceipt[]) => Promise<boolean>;
  restoreSavedClashReports: () => Promise<boolean>;
  retrySaveClashReports: () => Promise<boolean>;
  saveClashReport: (report: SavedClashReport) => Promise<boolean>;
  stageClashReport: (report: SavedClashReport) => void;
  renameSavedClashReport: (id: string, name: string) => Promise<boolean>;
  deleteSavedClashReport: (id: string) => Promise<boolean>;
}

export const createSavedClashReportsSlice: StateCreator<SavedClashReportsSlice, [], [], SavedClashReportsSlice> = (set, get) => {
  const library = createContentLibrary(clashReportsContent, () => get().savedClashReports, (entries, status) => set({
    savedClashReports: entries, savedClashReportsStorage: status,
  }));
  return {
    savedClashReports: [], savedClashReportsStorage: initialContentStatus(),
    initializeSavedClashReports: library.initialize, refreshSavedClashReports: library.refresh,
    restoreSavedClashReports: library.restore,
    retrySaveClashReports: library.retry,
    stageClashReport: entry => { if (isSavedClashReport(entry)) library.stage(entry.id, entry); },
    saveClashReport: report => {
      if (!isSavedClashReport(report)) { console.warn('[Clash reports] Refusing an invalid report'); return Promise.resolve(false); }
      const existing = get().savedClashReports.find(entry => entry.id === report.id);
      if (existing && !sameReportEvidence({ ...existing, name: report.name }, report)) {
        console.warn('[Clash reports] Refusing conflicting evidence ID', report.id); return Promise.resolve(false);
      }
      return library.put(report.id, report);
    },
    renameSavedClashReport: (id, name) => {
      const entry = get().savedClashReports.find(value => value.id === id);
      return entry && name.trim() ? library.put(id, { ...entry, name: name.trim() }) : Promise.resolve(false);
    },
    deleteSavedClashReport: id => library.put(id, null),
  };
};
