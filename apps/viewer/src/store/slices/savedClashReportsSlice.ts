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
 * and no edit can reach the controller before the validator is in place. */
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
  deleteSavedClashReport: (id: string, beforeWrite?: () => boolean) => Promise<boolean>;
}

/** `load` fetches the rules; a test passes one that fails, as a chunk the browser cannot fetch does. */
export const savedClashReportsSlice = (load: typeof loadClashReportLibrary = loadClashReportLibrary): StateCreator<SavedClashReportsSlice, [], [], SavedClashReportsSlice> => (set, get) => {
  const library = createContentLibrary(clashReportsContent, () => get().savedClashReports, (entries, status) => set({
    savedClashReports: entries, savedClashReportsStorage: status,
  }));
  // The rules are a chunk fetched on demand, and a fetch can fail. Then there are no rules (null): an edit is refused
  // like a failed write instead of rejecting, and opening still runs, so the library ends unreadable (its rows cannot
  // be validated) or empty, a state the next open can leave. Left "loading", it would disable every library's backup.
  const actions = () => load().then((module) => module.clashReportActions(library, () => get().savedClashReports, sameReportEvidence))
    .catch((error: unknown) => { console.warn('[Clash reports] The report rules could not be loaded', error); return null; });
  return {
    savedClashReports: [], savedClashReportsStorage: initialContentStatus(),
    initializeSavedClashReports: () => actions().then(library.initialize),
    refreshSavedClashReports: (committed) => actions().then((rules) => !!rules && library.refresh(committed)),
    restoreSavedClashReports: () => actions().then((rules) => !!rules && library.restore()),
    retrySaveClashReports: () => actions().then((rules) => !!rules && library.retry()),
    saveClashReport: (report) => actions().then((rules) => !!rules && rules.save(report)),
    stageClashReport: (report) => actions().then((rules) => rules?.stage(report)),
    renameSavedClashReport: (id, name) => actions().then((rules) => !!rules && rules.rename(id, name)),
    deleteSavedClashReport: (id, beforeWrite) => actions().then((rules) => !!rules && rules.remove(id, beforeWrite)),
  };
};

export const createSavedClashReportsSlice = savedClashReportsSlice();
