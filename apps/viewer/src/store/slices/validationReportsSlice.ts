/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StateCreator } from 'zustand';
import { newSavedReport, validateSavedReport, type SavedValidationReport, type ValidationReportSnapshot } from '@/lib/validation/reports/history';
import { loadValidationReports, persistValidationReports } from '@/lib/validation/reports/persistence';

export interface ValidationReportsSlice {
  savedValidationReports: SavedValidationReport[];
  validationReportsSaveFailed: boolean;
  saveValidationReport: (snapshot: ValidationReportSnapshot, name?: string) => string | null;
  renameValidationReport: (id: string, name: string) => void;
  removeValidationReport: (id: string) => void;
}

export const createValidationReportsSlice: StateCreator<ValidationReportsSlice, [], [], ValidationReportsSlice> = (set, get) => {
  const commit = (savedValidationReports: SavedValidationReport[]) => {
    const validationReportsSaveFailed = !persistValidationReports(savedValidationReports);
    set({ savedValidationReports, validationReportsSaveFailed });
  };
  return {
    savedValidationReports: loadValidationReports(),
    validationReportsSaveFailed: false,
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
