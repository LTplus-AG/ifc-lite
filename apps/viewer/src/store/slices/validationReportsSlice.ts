/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sameReportEvidence } from '@/lib/flow/report-provenance';
import type { StateCreator } from 'zustand';
import type { SavedHistoryIssue } from '@/lib/storage/saved-history';
import { newSavedReport, savedReportWithProvenance, validateSavedReport, type SavedValidationReport, type ValidationReportSnapshot } from '@/lib/validation/reports/history';
import { readValidationReports, persistValidationReports } from '@/lib/validation/reports/persistence';

export interface ValidationReportsSlice {
  savedValidationReports: SavedValidationReport[];
  validationReportsSaveFailed: boolean;
  validationReportsLoadIssue: SavedHistoryIssue | null;
  retryValidationReportsSave: () => void;
  saveValidationReport: (snapshot: ValidationReportSnapshot, name?: string) => string | null;
  saveValidationReportEntry: (entry: SavedValidationReport) => string | null;
  renameValidationReport: (id: string, name: string) => void;
  removeValidationReport: (id: string) => void;
}

export const createValidationReportsSlice: StateCreator<ValidationReportsSlice, [], [], ValidationReportsSlice> = (set, get) => {
  const loaded = readValidationReports();
  const commit = (savedValidationReports: SavedValidationReport[]) => {
    const saved = persistValidationReports(savedValidationReports);
    set({ savedValidationReports: saved.entries, validationReportsSaveFailed: !saved.ok, validationReportsLoadIssue: saved.issue });
  };
  return {
    savedValidationReports: loaded.entries,
    validationReportsLoadIssue: loaded.issue,
    validationReportsSaveFailed: false,
    retryValidationReportsSave: () => commit(get().savedValidationReports),
    saveValidationReport: (snapshot, name) => {
      const entry = newSavedReport(snapshot, name);
      return get().saveValidationReportEntry(entry);
    },
    saveValidationReportEntry: (entry) => {
      if (!validateSavedReport(entry)) { console.warn('[Validation reports] Refusing invalid report'); return null; }
      entry = savedReportWithProvenance(entry);
      const current = get().savedValidationReports;
      const existing = current.find((report) => report.id === entry.id);
      if (existing && !sameReportEvidence(savedReportWithProvenance(existing), entry)) {
        console.warn('[Validation reports] Refusing conflicting evidence ID', entry.id);
        return null;
      }
      commit(existing ? current.map((saved) => saved.id === entry.id ? entry : saved) : [...current, entry]);
      return entry.id;
    },
    renameValidationReport: (id, name) => {
      if (!name.trim()) return;
      commit(get().savedValidationReports.map((entry) => entry.id === id ? { ...entry, name: name.trim() } : entry));
    },
    removeValidationReport: (id) => commit(get().savedValidationReports.filter((entry) => entry.id !== id)),
  };
};
