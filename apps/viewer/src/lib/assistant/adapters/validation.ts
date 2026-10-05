/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { analysisStampOf } from '@/hooks/useAnalysisStaleness';
import { useValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { unavailableCapture, type EvidenceAdapter } from './types';

/** IDS and information-rule reports: specification rows, then their entity and set results. */
export const validationAdapter: EvidenceAdapter = {
  id: 'validation', group: 'checks', panelIds: ['validation'],
  // The panel's IDS/rules side, and only while the attached report is from that side.
  panelSubject: s => {
    const choice = useValidationSourceChoice.getState().choice;
    return choice === null || (choice !== 'manual' && choice === s.idsValidationReport?.source.kind);
  },
  titleKey: 'validationPanel.title', descriptionKey: 'assistant.pickValidationDescription',
  rowMeaningKey: 'assistant.evidenceRowsValidation', unavailableKey: 'assistant.evidenceUnavailableValidation',
  suggestionKeys: ['assistant.suggestValidationSummary', 'assistant.suggestValidationRequirements', 'assistant.suggestValidationCorrections', 'sceneActions.suggestShowFailing',
    'assistant.suggestIdsDraft', 'assistant.suggestReportOutline'],
  readiness: s => s.idsValidationReport
    ? { status: { labelKey: 'assistant.pickSpecifications', params: { count: s.idsValidationReport.specificationResults.length } }, ready: true }
    : { status: { labelKey: 'assistant.pickNoReport' }, ready: false },
  identity: s => s.idsValidationReport,
  reportStamp: s => analysisStampOf(s.idsValidationReport),
  capture: (s, limit) => {
    const report = s.idsValidationReport;
    if (!report) return unavailableCapture();
    const rows: unknown[] = [];
    let totalRows = 0;
    for (const spec of report.specificationResults) {
      totalRows++;
      if (rows.length < limit) rows.push({ specification: spec.specification, status: spec.status, applicableCount: spec.applicableCount,
        passedCount: spec.passedCount, failedCount: spec.failedCount, error: spec.error, cardinalityResult: spec.cardinalityResult });
      totalRows += spec.entityResults.length + (spec.setResults?.length ?? 0);
      for (const entity of spec.entityResults.slice(0, Math.max(0, limit - rows.length))) rows.push({ specificationId: spec.specification.id, ...entity });
      for (const set of (spec.setResults ?? []).slice(0, Math.max(0, limit - rows.length))) rows.push({ specificationId: spec.specification.id, ...set });
    }
    return { summary: { summary: report.summary, source: report.source.kind, timestamp: report.timestamp, modelInfo: report.modelInfo },
      rows, totalRows, availability: 'available' };
  },
};
