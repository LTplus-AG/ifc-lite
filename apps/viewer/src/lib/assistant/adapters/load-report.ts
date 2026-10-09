/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NEW_IFC_CAPABILITY } from '@/lib/actions/new-ifc-file';
import { buildLoadReports } from '../../loadReport';
import type { EvidenceAdapter } from './types';

/** One original-load report per model; missing diagnostics are unavailable, never clean. */
export const loadReportAdapter: EvidenceAdapter = {
  id: 'loadReport', group: 'model', panelIds: ['loadReport'],
  titleKey: 'newIfc.modelsTitle', descriptionKey: 'newIfc.modelsDescription',
  rowMeaningKey: 'assistant.evidenceRowsLoadReport', unavailableKey: 'assistant.evidenceUnavailableLoadReport',
  suggestionKeys: ['newIfc.suggest', 'assistant.suggestLoadReport', 'assistant.suggestAuthoring', 'assistant.suggestIdsDraft', 'assistant.suggestRulesDraft', 'assistantArtifacts.suggestList', 'assistantArtifacts.suggestChart'],
  readiness: s => s.models.size ? { status: { labelKey: 'assistant.pickModels', params: { count: s.models.size } }, ready: true }
    : { status: { labelKey: 'newIfc.capabilityReady' }, ready: true },
  identity: s => s.models,
  capture: (s, limit) => {
    const reports = buildLoadReports(s.models);
    return {
      summary: { kind: 'model-load-reports', modelCount: reports.length, loadReportsAvailable: reports.length > 0, nativeNewIfc: NEW_IFC_CAPABILITY,
        diagnosticsAvailable: reports.filter(report => report.diagnosticsAvailable).length,
        diagnosticsUnavailable: reports.filter(report => !report.diagnosticsAvailable).length,
        cleanLoads: reports.filter(report => report.isClean).length,
        limitations: 'Load diagnostics describe the original load, not validation of later edits. Affected entities are only those supplied by native diagnostics; missing diagnostics never mean clean.' },
      totalRows: reports.length,
      availability: 'available',
      rows: reports.slice(0, limit),
    };
  },
};
