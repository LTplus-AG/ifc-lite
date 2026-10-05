/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Re-run validation" for an applied correction batch (P15): runs the
 * receipt's IDS or rule-set check again on the edited model through the same
 * native services the validation panel uses, publishes the new report the
 * same way, and records the new per-specification counts on the receipt.
 * The counts are the native engine's; nothing here interprets a verdict.
 */

import type { StoreApi } from 'zustand';
import type { ValidationReport } from '@ifc-lite/ids';
import type { ViewerState } from '@/store';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { isNativeWorkflowBusy } from '@/lib/flow/run-session';
import { definedModelTagIdsOf, evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { runIdsCheck } from '@/lib/validation/run-ids-check';
import { runInformationCheck } from '@/lib/validation/run-information-check';
import type { ModelChangeReceipt } from './model-change-commit';
import { modelChangeLibrary, useModelChangeReceipts } from './receipts';
import { reportTitle, verdictCounts, type ReceiptValidation } from './validation-verdicts';

export type RerunOutcome =
  | { ok: true; receipt: ModelChangeReceipt }
  | { ok: false; reason: 'no-baseline' | 'no-report' | 'source-changed' | 'other-model' | 'rule-set-unavailable' | 'model-unavailable' | 'busy' | 'failed'; detail?: string };

/** Run the receipt's check again on the current model and record its counts on a copy of the receipt. */
export async function rerunReceiptValidation(store: StoreApi<ViewerState>, receipt: ModelChangeReceipt): Promise<RerunOutcome> {
  const baseline = receipt.validation;
  if (!baseline) return { ok: false, reason: 'no-baseline' };
  if (isNativeWorkflowBusy()) return { ok: false, reason: 'busy' };
  const state = store.getState();
  const report = state.idsValidationReport;
  if (!report) return { ok: false, reason: 'no-report' };
  if (report.source.kind !== baseline.source || reportTitle(report) !== baseline.title) return { ok: false, reason: 'source-changed' };
  const stamp = captureAnalysisStamp();
  try {
    let result: { report: ValidationReport; snapshot: Awaited<ReturnType<typeof runIdsCheck>>['snapshot'] };
    if (report.source.kind === 'ids') {
      const modelId = report.modelInfo[0]?.modelId;
      const dataStore = modelId ? state.models.get(modelId)?.ifcDataStore : undefined;
      if (!modelId || !dataStore) return { ok: false, reason: 'model-unavailable' };
      // A report on another model would show "no change" for edits it never saw.
      if (!receipt.batches.some(batch => batch.modelId === modelId)) return { ok: false, reason: 'other-model' };
      result = await runIdsCheck({ document: report.source.document, modelId, dataStore, mutationView: state.mutationViews.get(modelId),
        locale: state.idsLocale, models: state.models });
    } else {
      const ruleSet = state.validationRuleSetDraft;
      if (!ruleSet || ruleSet.name !== baseline.title) return { ok: false, reason: 'rule-set-unavailable' };
      result = await runInformationCheck({ ruleSet, models: evaluatorModelsFromState(state),
        definedModelTagIds: definedModelTagIdsOf(state), reportModels: state.models });
    }
    store.getState().setIdsValidationReport(stampAnalysisReport(result.report, stamp), result.snapshot);
    return { ok: true, receipt: { ...receipt, validation: { ...baseline, after: verdictCounts(result.report), rerunAt: new Date().toISOString() } } };
  } catch (error) {
    console.error('[model-changes] validation rerun failed', error);
    return { ok: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}


/**
 * Record rerun counts on the receipt as it is now: an undo that landed while
 * the check ran keeps its status, and an undone receipt gets no counts (they
 * describe the applied state). Returns whether the counts were recorded.
 */
export async function recordReceiptRerun(receiptId: string, validation: ReceiptValidation): Promise<boolean> {
  const latest = useModelChangeReceipts.getState().entries.find(entry => entry.id === receiptId);
  if (!latest || latest.status !== 'applied') return false;
  return modelChangeLibrary.put(receiptId, { ...latest, validation });
}
