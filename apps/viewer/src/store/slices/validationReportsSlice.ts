/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sameReportEvidence } from '@/lib/flow/report-provenance';
import type { StateCreator } from 'zustand';
import type { ContentCommitReceipt } from '@/lib/storage/content-library';
import { createContentLibrary, initialContentStatus, type ContentStatus } from '@/lib/storage/content-library';
import { newSavedReport, savedReportWithProvenance, validateSavedReport, type SavedValidationReport, type ValidationReportSnapshot } from '@/lib/validation/reports/history';
import { validationContent } from '@/lib/validation/reports/persistence';

export interface ValidationReportsSlice {
  savedValidationReports: SavedValidationReport[];
  validationReportsStorage: ContentStatus;
  initializeValidationReports: () => Promise<boolean>;
  refreshValidationReports: (committed?: readonly ContentCommitReceipt[]) => Promise<boolean>;
  restoreValidationReports: () => Promise<boolean>;
  retryValidationReportsSave: () => Promise<boolean>;
  saveValidationReport: (snapshot: ValidationReportSnapshot, name?: string) => Promise<string | null>;
  saveValidationReportEntry: (entry: SavedValidationReport) => Promise<string | null>;
  stageValidationReport: (entry: SavedValidationReport) => void;
  renameValidationReport: (id: string, name: string) => Promise<boolean>;
  removeValidationReport: (id: string) => Promise<boolean>;
}

export const createValidationReportsSlice: StateCreator<ValidationReportsSlice, [], [], ValidationReportsSlice> = (set, get) => {
  const library = createContentLibrary(validationContent, () => get().savedValidationReports, (entries, status) => set({
    savedValidationReports: entries, validationReportsStorage: status,
  }));
  return {
    savedValidationReports: [], validationReportsStorage: initialContentStatus(),
    initializeValidationReports: library.initialize, refreshValidationReports: library.refresh,
    restoreValidationReports: library.restore,
    retryValidationReportsSave: library.retry,
    stageValidationReport: entry => { if (validateSavedReport(entry)) library.stage(entry.id, savedReportWithProvenance(entry)); },
    saveValidationReport: (snapshot, name) => get().saveValidationReportEntry(newSavedReport(snapshot, name)),
    saveValidationReportEntry: async (raw) => {
      if (!validateSavedReport(raw)) { console.warn('[Validation reports] Refusing invalid report'); return null; }
      const entry = savedReportWithProvenance(raw);
      const existing = get().savedValidationReports.find(report => report.id === entry.id);
      if (existing && !sameReportEvidence({ ...existing, name: entry.name }, entry)) {
        console.warn('[Validation reports] Refusing conflicting evidence ID', entry.id); return null;
      }
      const saved = await library.put(entry.id, entry);
      if (!saved && get().validationReportsStorage.items[entry.id] === 'invalid') return null;
      // The ID also identifies memory-only evidence, so a retry cannot duplicate it.
      return entry.id;
    },
    renameValidationReport: (id, name) => {
      const entry = get().savedValidationReports.find(report => report.id === id);
      return entry && name.trim() ? library.put(id, { ...entry, name: name.trim() }) : Promise.resolve(false);
    },
    removeValidationReport: id => library.put(id, null),
  };
};
