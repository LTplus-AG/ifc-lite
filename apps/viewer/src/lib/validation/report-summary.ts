/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The engine's counts and bounded pass rate, shared by live results and
 * frozen report snapshots (#6552). Warning failures occupy their own bucket. */
import { calculateSummary, type ValidationReport } from '@ifc-lite/ids';
import type { ManualCounts } from './manual/checklist-summary.js';

export interface ReportSummary {
  checked: number; passed: number; failed: number; passRate: number; warnings?: number;
}

export function validationReportSummary(report: ValidationReport): ReportSummary {
  const summary = calculateSummary(report.specificationResults);
  const totals = { checked: summary.totalEntitiesChecked, passed: summary.totalEntitiesPassed,
    failed: summary.totalEntitiesFailed, passRate: summary.overallPassRate };
  if (report.source.kind !== 'rules') return totals;
  const warnings = report.specificationResults.reduce((sum, check) =>
    sum + (check.specification.severity === 'warning' ? check.failedCount : 0), 0);
  return { ...totals, failed: totals.failed - warnings, warnings };
}

/** Unevaluated outcomes keep the neutral segment; the percentage remains
 * the engine's bounded value even when a cardinality constraint failed. */
export function reportRingCounts(summary: ReportSummary): ManualCounts {
  const warning = summary.warnings ?? 0;
  return { total: summary.checked, pass: summary.passed, fail: summary.failed, warning,
    unanswered: Math.max(0, summary.checked - summary.passed - summary.failed - warning) };
}
