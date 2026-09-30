/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StateCreator } from 'zustand';
import type { SavedHistoryIssue } from '@/lib/storage/saved-history';
import { newSavedReport, validateSavedReport, type SavedValidationReport, type ValidationReportSnapshot } from '@/lib/validation/reports/history';
import { readValidationReports, persistValidationReports } from '@/lib/validation/reports/persistence';

export interface ValidationReportsSlice {
  savedValidationReports: SavedValidationReport[];
  validationReportsSaveFailed: boolean;
  validationReportsLoadIssue: SavedHistoryIssue | null;
  retryValidationReportsSave: () => void;
  saveValidationReport: (snapshot: ValidationReportSnapshot, name?: string) => string | null;
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
      if (!validateSavedReport(entry)) { console.warn('[Validation reports] Refusing invalid report'); return null; }
      commit([...get().savedValidationReports, entry]);
      return entry.id;
    },
    renameValidationReport: (id, name) => {
      if (!name.trim()) return;
      commit(get().savedValidationReports.map((entry) => entry.id === id ? { ...entry, name: name.trim() } : entry));
    },
    removeValidationReport: (id) => commit(get().savedValidationReports.filter((entry) => entry.id !== id)),
  };
};
