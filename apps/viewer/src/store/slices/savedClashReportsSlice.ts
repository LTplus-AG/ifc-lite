/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StateCreator } from 'zustand';
import { clashReportsContent, loadClashReportLibrary } from '@/lib/clash/saved-report-persistence';
import type { SavedClashReport } from '@/lib/clash/saved-report-schema';
import { sameReportEvidence } from '@/lib/flow/report-provenance';
import { createContentLibrary, initialContentStatus, type ContentCommitReceipt, type ContentStatus } from '@/lib/storage/content-library';

/** Saved clash reports (#6947): the same library controller and save states as
 * saved comparisons. The validator and the save, rename and delete rules load
 * on first use (`saved-report-library`), so every action here is asynchronous
 * and none can reach the controller before the validator is in place. */
export interface SavedClashReportsSlice {
  savedClashReports: SavedClashReport[];
  savedClashReportsStorage: ContentStatus;
  initializeSavedClashReports: () => Promise<boolean>;
  refreshSavedClashReports: (committed?: readonly ContentCommitReceipt[]) => Promise<boolean>;
  restoreSavedClashReports: () => Promise<boolean>;
  retrySaveClashReports: () => Promise<boolean>;
  saveClashReport: (report: SavedClashReport) => Promise<boolean>;
  stageClashReport: (report: SavedClashReport) => Promise<void>;
  renameSavedClashReport: (id: string, name: string) => Promise<boolean>;
  deleteSavedClashReport: (id: string) => Promise<boolean>;
}

export const createSavedClashReportsSlice: StateCreator<SavedClashReportsSlice, [], [], SavedClashReportsSlice> = (set, get) => {
  const library = createContentLibrary(clashReportsContent, () => get().savedClashReports, (entries, status) => set({
    savedClashReports: entries, savedClashReportsStorage: status,
  }));
  const actions = () => loadClashReportLibrary().then((module) => module.clashReportActions(library, () => get().savedClashReports, sameReportEvidence));
  return {
    savedClashReports: [], savedClashReportsStorage: initialContentStatus(),
    initializeSavedClashReports: () => actions().then(library.initialize),
    refreshSavedClashReports: (committed) => actions().then(() => library.refresh(committed)),
    restoreSavedClashReports: () => actions().then(library.restore),
    retrySaveClashReports: () => actions().then(library.retry),
    saveClashReport: (report) => actions().then((rules) => rules.save(report)),
    stageClashReport: (report) => actions().then((rules) => rules.stage(report)),
    renameSavedClashReport: (id, name) => actions().then((rules) => rules.rename(id, name)),
    deleteSavedClashReport: (id) => actions().then((rules) => rules.remove(id)),
  };
};
