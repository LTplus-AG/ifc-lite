/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreApi } from 'zustand';
import type { ValidationReport } from '@ifc-lite/ids';
import type { ValidationReportSnapshot } from '@/lib/validation/reports/history';
import type { IDSSlice } from './idsSlice.js';
import { buildEntityIdSets } from './idsSlice.entity-sets.js';

/** Completion-time evidence stays in this session until explicitly saved (#6568).
 * Tie it to the exact live report so stale controls cannot save a different run. */
export interface CurrentValidationReport {
  report: ValidationReport;
  snapshot: ValidationReportSnapshot;
  savedReportId: string | null;
}

export function createValidationReportActions(set: StoreApi<IDSSlice>['setState'], get: () => IDSSlice, endRowFocus: () => void): Pick<IDSSlice,
  'setIdsValidationReport' | 'clearIdsValidationReport' | 'markValidationReportSaved'> {
  return {
    setIdsValidationReport: (report, snapshot) => {
      const { failed, passed } = buildEntityIdSets(report);
      // Release presentation before replacing the focused row's report.
      endRowFocus();
      set({
        idsValidationReport: report,
        currentValidationReport: report && snapshot ? { report, snapshot, savedReportId: null } : null,
        validationSource: report ? report.source.kind : null,
        idsFailedEntityIds: failed, idsPassedEntityIds: passed,
        idsColorsShown: true, idsIsolateMode: null, idsFocusVisibilityOwned: null,
        idsError: null, idsProgress: null,
      });
    },
    markValidationReportSaved: (report, id) => {
      const current = get().currentValidationReport;
      if (current?.report === report && get().idsValidationReport === report) set({ currentValidationReport: { ...current, savedReportId: id } });
    },
    clearIdsValidationReport: () => {
      // Clear ends the epoch, so an in-flight run will skip its own finally.
      // This action must reset loading/progress and release focus first (#2837).
      endRowFocus();
      set({
        idsValidationReport: null, currentValidationReport: null, validationSource: null,
        idsActiveSpecificationId: null, idsActiveEntityId: null,
        idsIsolationScope: 'ids', idsIsolateMode: null, idsFocusVisibilityOwned: null,
        idsFailedEntityIds: new Set(), idsPassedEntityIds: new Set(),
        idsLoading: false, idsProgress: null,
      });
    },
  };
}
