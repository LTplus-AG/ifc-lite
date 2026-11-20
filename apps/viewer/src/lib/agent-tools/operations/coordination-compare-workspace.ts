/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { coordination, idSchema, textSchema } from './coordination-common';
import { emptySchema } from './contract';
import { isUncachedCompareResult } from '@/lib/compare/publish-comparison';
function result() { const state = useViewerStore.getState(); if (!state.compareResult) throw new Error('Run a native model comparison first.'); return { state, result: state.compareResult }; }
export const coordinationCompareWorkspaceOperations = [
  coordination('compare.exportReport', 'Build CSV from the native comparison report serializer, including IFC fields, change classification and safe CSV escaping.', ['artifact'], emptySchema, async (_, c) => {
    const [{ buildCompareReport, reportToCsv }, { modelsAsCompared }] = await Promise.all([import('@/lib/compare/exportReport'), import('@/lib/compare/comparedModels')]);
    const { state, result: current } = result(); const report = buildCompareReport(current, modelsAsCompared(state.models, current.comparedStores), state.compareExcludedTypes); c.checkpoint?.();
    return c.artifacts.create({ filename: 'model-comparison.csv', mimeType: 'text/csv;charset=utf-8', data: reportToCsv(report) });
  }),
  coordination('compare.saveReport', 'Capture the current native comparison as immutable portable evidence and await durable storage.', ['configuration'], textSchema, async (i, c) => {
    const { snapshotComparison } = await import('@/lib/compare/savedComparisons'); const { state, result: current } = result(); const snapshot = snapshotComparison(current, state.models, i.value);
    return c.commitAsync(async () => ({ id: snapshot.id, saved: await useViewerStore.getState().saveComparison(snapshot) }), result => result.saved);
  }),
  coordination('compare.savedReports', 'Initialize and read native saved comparison evidence and storage status.', ['read'], emptySchema, async () => {
    await useViewerStore.getState().initializeSavedComparisons(); const s = useViewerStore.getState(); return { reports: s.savedComparisons, storage: s.savedComparisonsStorage };
  }),
  coordination<{ id: string; name: string }>('compare.renameSavedReport', 'Rename one native saved comparison without changing its evidence.', ['configuration'], {
    type: 'object', properties: { id: { type: 'string', minLength: 1, maxLength: 200 }, name: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['id', 'name'], additionalProperties: false,
  }, (i, c) => c.commitAsync(async () => ({ id: i.id, saved: await useViewerStore.getState().renameSavedComparison(i.id, i.name) }), result => result.saved)),
  coordination('compare.deleteSavedReport', 'Delete one exact saved comparison through the native CAS content library.', ['configuration'], idSchema, (i, c) => c.commitAsync(async () => {
    if (!useViewerStore.getState().savedComparisons.some(entry => entry.id === i.id)) throw new Error('Unknown saved comparison.');
    return { id: i.id, deleted: await useViewerStore.getState().deleteSavedComparison(i.id) };
  }, result => result.deleted)),
  coordination('compare.openSavedReport', 'Focus one exact native immutable comparison report in its owning panel.', ['view', 'configuration'], idSchema, async (i, c) => {
    const { useSavedComparisonFocus } = await import('@/lib/panels/evidence-focus');
    return c.commit(() => {
      if (!useViewerStore.getState().savedComparisons.some(entry => entry.id === i.id)) throw new Error('Unknown saved comparison.');
      useSavedComparisonFocus.setState({ record: { comparisonId: i.id, key: '' } }); useViewerStore.getState().openWorkspacePanel('compare'); return { opened: i.id };
    });
  }),
  coordination<{ action: 'accept' | 'reject' | 'remove'; base_model_id: string; head_model_id: string; base: string; here: string; reason: string; key_property: string }>('compare.identityDecision', 'Record one explicit identity decision for the exact current native model pair and authored key scheme. Decisions remain pair-scoped; returns refused aliases and requires rerunning the comparison when the panel cache is absent.', ['configuration'], {
    type: 'object', properties: { key_property: { type: 'string', maxLength: 500 }, action: { type: 'string', enum: ['accept', 'reject', 'remove'] }, base_model_id: { type: 'string', minLength: 1, maxLength: 200 }, head_model_id: { type: 'string', minLength: 1, maxLength: 200 }, base: { type: 'string', minLength: 1, maxLength: 2000 }, here: { type: 'string', minLength: 1, maxLength: 2000 }, reason: { type: 'string', maxLength: 2000 } }, required: ['action', 'base_model_id', 'head_model_id', 'base', 'here', 'reason', 'key_property'], additionalProperties: false,
  }, (i, c) => c.commit(() => {
    const { state, result: current } = result();
    // The aliases were read under one authored key scheme; refuse them under another.
    if (current.baseModelId !== i.base_model_id || current.headModelId !== i.head_model_id || current.keyProperty !== state.compareKeyProperty || (current.keyProperty ?? '') !== i.key_property) throw new Error('Comparison pair or authored key scheme changed.');
    const pair = { baseModelId: i.base_model_id, headModelId: i.head_model_id, keyProperty: current.keyProperty };
    const refused = i.action === 'accept' ? state.acceptCompareIdentity(pair, [{ base: i.base, here: i.here, reason: i.reason }]) : [];
    if (i.action === 'reject') state.rejectCompareClaim(pair, i.base, i.here); if (i.action === 'remove') state.removeCompareIdentity(pair, i.base, i.here);
    // An agent-published result has no cached pair to re-diff, so it cannot carry the decision: drop it.
    if (isUncachedCompareResult(current)) useViewerStore.getState().setCompareResult(null);
    return { action: i.action, refused, accepted: useViewerStore.getState().compareAcceptedIdentity, rejected: useViewerStore.getState().compareRejectedClaims };
  })),
  coordination<{ kind: 'clash' | 'validation' }>('compare.captureRun', 'Hold the current native clash or validation run for cross-revision reconciliation; never reruns or fabricates a check.', ['configuration'], {
    type: 'object', properties: { kind: { type: 'string', enum: ['clash', 'validation'] } }, required: ['kind'], additionalProperties: false,
  }, async (i: { kind: 'clash' | 'validation' }, c) => {
    const { captureClashRun, captureValidationRun } = await import('@/lib/compare/compare-analysis-state');
    return c.commit(() => { const s = useViewerStore.getState(), captured = i.kind === 'clash' ? captureClashRun(s) : captureValidationRun(s); if (!captured) throw new Error('No native run is available to capture.'); return { id: s.addCompareRunCapture(captured), kind: captured.kind }; });
  }),
  coordination('compare.runs', 'Read held native run captures and the current reconciliation result.', ['read'], emptySchema, () => ({ runs: useViewerStore.getState().compareRunCaptures, reconciliation: useViewerStore.getState().compareReconciliation })),
  coordination<{ base_run_id: string; head_run_id: string }>('compare.reconcile', 'Reconcile two exact held native runs against the current comparison; reports native compatibility/refusal reasons and does not infer resolved from missing coverage.', ['configuration'], {
    type: 'object', properties: { base_run_id: { type: 'string', minLength: 1, maxLength: 200 }, head_run_id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['base_run_id', 'head_run_id'], additionalProperties: false,
  }, async (i, c) => {
    const { savedReconciliationOf } = await import('@/lib/compare/compare-reconcile-state');
    return c.commit(() => { const s = useViewerStore.getState(), base = s.compareRunCaptures.find(run => run.id === i.base_run_id), head = s.compareRunCaptures.find(run => run.id === i.head_run_id); if (!base || !head) throw new Error('Unknown held analysis run.'); const saved = savedReconciliationOf(s, base, head); if (!saved) throw new Error('Run a model comparison first.'); s.setCompareReconciliation(saved); return { outcome: saved.outcome }; });
  }),
  coordination('compare.savedAnalysisRuns', 'Initialize and inspect immutable native analysis-run evidence and save status.', ['read'], emptySchema, async () => {
    const { analysisRunLibrary, useSavedAnalysisRuns } = await import('@/lib/compare/saved-analysis-runs'); await analysisRunLibrary.initialize(); const state = useSavedAnalysisRuns.getState(); return { runs: state.entries, storage: state.status };
  }),
  coordination('compare.saveAnalysisRun', 'Save one held native run through the portable source-identity codec and immutable analysis-run content library.', ['configuration'], idSchema, async (i, c) => {
    const [{ portableAnalysisRun }, { saveAnalysisRun }] = await Promise.all([import('@/lib/compare/saved-analysis-run-binding'), import('@/lib/compare/saved-analysis-runs')]);
    const state = useViewerStore.getState(), run = state.compareRunCaptures.find(run => run.id === i.id); if (!run) throw new Error('Unknown held run.');
    const portable = portableAnalysisRun(run, state); if (!portable.ok) return { saved: false, refusal: portable };
    return c.commitAsync(async () => ({ saved: await saveAnalysisRun(portable.saved), id: portable.saved.id }), result => result.saved);
  }),
  coordination('compare.bindSavedAnalysisRun', 'Bind saved evidence only to exactly matching native model content/placement, returning all native refusal reasons instead of guessing model identities.', ['configuration'], idSchema, async (i, c) => {
    const [{ bindSavedAnalysisRun }, { useSavedAnalysisRuns }] = await Promise.all([import('@/lib/compare/saved-analysis-run-binding'), import('@/lib/compare/saved-analysis-runs')]);
    return c.commit(() => { const saved = useSavedAnalysisRuns.getState().entries.find(run => run.id === i.id); if (!saved) throw new Error('Unknown saved analysis run.'); const bound = bindSavedAnalysisRun(saved, useViewerStore.getState()); if (!bound.ok) return bound; return { ok: true, id: useViewerStore.getState().addCompareRunCapture(bound.run) }; });
  }),
  coordination('compare.deleteSavedAnalysisRun', 'Delete one exact native immutable saved analysis run through its content library.', ['configuration'], idSchema, async (i, c) => {
    const { deleteSavedAnalysisRun, useSavedAnalysisRuns } = await import('@/lib/compare/saved-analysis-runs'); if (!useSavedAnalysisRuns.getState().entries.some(run => run.id === i.id)) throw new Error('Unknown saved analysis run.'); return c.commitAsync(async () => ({ deleted: await deleteSavedAnalysisRun(i.id), id: i.id }), result => result.deleted);
  }),
  coordination('compare.removeRun', 'Remove one exact held run and invalidate reconciliation that depended on it.', ['configuration'], idSchema, (i, c) => c.commit(() => {
    const s = useViewerStore.getState(); if (!s.compareRunCaptures.some(run => run.id === i.id)) throw new Error('Unknown held run.'); s.removeCompareRunCapture(i.id); return { removed: i.id };
  })),
];
