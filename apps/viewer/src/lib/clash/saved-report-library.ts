/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The saved clash report actions (#6947): the immutable-evidence rule saved
 * comparisons have, where only the name may change. Loaded on demand through
 * `loadClashReportLibrary`; `savedClashReportsSlice` holds the state and the
 * library controller and forwards every action here.
 *
 * This module imports nothing from the boot bundle on purpose: what it needs
 * from there arrives as arguments. A static import would make the bundler
 * split those shared modules into another boot-time chunk.
 */

import { isSavedClashReport, type SavedClashReport } from './saved-report-schema';

export { isSavedClashReport };

/** The controller `createContentLibrary` returns, as far as these actions use it. */
interface Controller {
  put: (id: string, value: SavedClashReport | null) => Promise<boolean>;
  stage: (id: string, entry: SavedClashReport | null) => void;
}

export interface ClashReportActions {
  save: (report: SavedClashReport) => Promise<boolean>;
  stage: (report: SavedClashReport) => void;
  rename: (id: string, name: string) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
}

export function clashReportActions(library: Controller, reports: () => readonly SavedClashReport[],
  sameEvidence: (left: unknown, right: unknown) => boolean): ClashReportActions {
  return {
    stage: (entry) => { if (isSavedClashReport(entry)) library.stage(entry.id, entry); },
    save: (report) => {
      if (!isSavedClashReport(report)) { console.warn('[Clash reports] Refusing an invalid report'); return Promise.resolve(false); }
      const existing = reports().find((entry) => entry.id === report.id);
      if (existing && !sameEvidence({ ...existing, name: report.name }, report)) {
        console.warn('[Clash reports] Refusing conflicting evidence ID', report.id); return Promise.resolve(false);
      }
      return library.put(report.id, report);
    },
    rename: (id, name) => {
      const entry = reports().find((value) => value.id === id);
      return entry && name.trim() ? library.put(id, { ...entry, name: name.trim() }) : Promise.resolve(false);
    },
    remove: (id) => library.put(id, null),
  };
}
