/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Validation verdict counts recorded on reviewed-change receipts (P15): the
 * current IDS or rule-set report's per-specification passed/failed counts at
 * apply, with whether that report described the model as it was just before
 * the apply, and the counts of a later rerun. Light on purpose: receipts are
 * decoded wherever the Changes panel renders; the rerun itself lives in
 * `validation-rerun.ts` and is loaded on demand.
 */

import type { ValidationReport } from '@ifc-lite/ids';
import type { ViewerState } from '@/store';
import { analysisStampOf } from '@/hooks/useAnalysisStaleness';

export interface VerdictCount { id: string; name: string; passed: number; failed: number }

export interface ReceiptValidation {
  source: 'ids' | 'rules';
  /** IDS title or rule set name: the check a rerun must match. */
  title: string;
  before: VerdictCount[];
  /** Whether the recorded report described the model as it was immediately before the apply. */
  beforeFreshness: 'current' | 'stale' | 'unknown';
  after?: VerdictCount[];
  rerunAt?: string;
}

export const VERDICT_SPEC_LIMIT = 200;

export function verdictCounts(report: ValidationReport): VerdictCount[] {
  return report.specificationResults.slice(0, VERDICT_SPEC_LIMIT).map((result) => ({
    id: result.specification.id, name: result.specification.name, passed: result.passedCount, failed: result.failedCount,
  }));
}

export function reportTitle(report: ValidationReport): string {
  return report.source.kind === 'ids' ? report.source.document.info.title : report.source.ruleSet.name;
}

/** Counts of the current report, recorded on a receipt at apply; undefined when no check has run. */
export function captureValidationBefore(state: ViewerState): ReceiptValidation | undefined {
  const report = state.idsValidationReport;
  if (!report) return undefined;
  const stamp = analysisStampOf(report);
  return { source: report.source.kind, title: reportTitle(report), before: verdictCounts(report),
    beforeFreshness: !stamp ? 'unknown' : stamp.mutationVersion === state.mutationVersion ? 'current' : 'stale' };
}

export interface VerdictDelta { id: string; name: string; before: VerdictCount | null; after: VerdictCount | null }

/** Specifications whose counts differ between the recorded runs, in report order. */
export function verdictDelta(validation: ReceiptValidation): VerdictDelta[] {
  if (!validation.after) return [];
  const before = new Map(validation.before.map((count) => [count.id, count]));
  const rows: VerdictDelta[] = validation.after.map((after) => ({ id: after.id, name: after.name, before: before.get(after.id) ?? null, after }));
  const seen = new Set(validation.after.map((count) => count.id));
  for (const count of validation.before) if (!seen.has(count.id)) rows.push({ id: count.id, name: count.name, before: count, after: null });
  return rows.filter((row) => row.before?.passed !== row.after?.passed || row.before?.failed !== row.after?.failed);
}
