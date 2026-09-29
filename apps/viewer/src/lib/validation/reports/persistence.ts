/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { validateSavedReport, type SavedValidationReport } from './history.js';

export const VALIDATION_REPORTS_STORAGE_KEY = 'ifc-lite-validation-reports-v1';

export function loadValidationReports(): SavedValidationReport[] {
  try {
    const raw = localStorage.getItem(VALIDATION_REPORTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) { console.warn('[Validation reports] Invalid saved history'); return []; }
    const ids = new Set<string>();
    return parsed.filter((entry: unknown): entry is SavedValidationReport => {
      if (!validateSavedReport(entry) || ids.has(entry.id)) {
        console.warn('[Validation reports] Dropping invalid or duplicate report');
        return false;
      }
      ids.add(entry.id);
      return true;
    });
  } catch (error) {
    console.warn('[Validation reports] Failed to load history', error);
    return [];
  }
}

/** Keep the in-memory evidence even on quota failure; the UI reports that it
 * will not survive a reload instead of claiming a successful save. */
export function persistValidationReports(reports: readonly SavedValidationReport[]): boolean {
  try {
    localStorage.setItem(VALIDATION_REPORTS_STORAGE_KEY, JSON.stringify(reports));
    return true;
  } catch (error) {
    console.warn('[Validation reports] Failed to save history', error);
    return false;
  }
}
