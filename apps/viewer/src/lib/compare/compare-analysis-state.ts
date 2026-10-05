/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The store-facing half of comparison impact and run reconciliation (#6921):
 * reads the live viewer state into the pure inputs of `impact.ts` and
 * `run-reconcile.ts`. Nothing here computes a finding.
 */

import type { ViewerState } from '@/store';
import { analysisStampOf, isAnalysisStale, type AnalysisStamp } from '@/hooks/useAnalysisStaleness';
import { gatheredModelIds } from '@/lib/clash/federation-identity';
import { computeCompareImpact, type CompareImpact } from './impact';
import { reconcileRuns } from './run-reconcile';
import type { CapturedRun, ReconcileContext, ReconcileOutcome, SavedReconciliation } from './run-reconcile-types';

type State = Pick<ViewerState, 'compareResult' | 'models' | 'clashResult' | 'clashRawResult' | 'idsValidationReport'
  | 'listResult' | 'listDefinitions' | 'activeListId' | 'bcfProject' | 'mutationVersion' | 'geometryContentVersion' | 'modelPlacement'>;
type ReconciliationState = State & Pick<ViewerState, 'compareReconciliation'>;

function staleness(state: State) {
  return { mutationVersion: state.mutationVersion, geometryContentVersion: state.geometryContentVersion,
    modelPlacement: state.modelPlacement, models: state.models };
}

/** Whether a stamped result predates later edits; null when it carries no stamp (freshness unknown). */
function freshness(state: State, stamp: AnalysisStamp | null): boolean | null {
  return stamp ? isAnalysisStale(stamp, staleness(state)) : null;
}

/** GlobalId of a compared entity, read from the store the diff actually ran on. */
function globalIdReader(state: State) {
  const stores = state.compareResult?.comparedStores;
  return (modelId: string, localId: number): string | undefined =>
    (stores?.get(modelId) ?? state.models.get(modelId)?.ifcDataStore)?.entities.getGlobalId(localId) || undefined;
}

export function compareImpactOf(state: State, rowLimit?: number): CompareImpact | null {
  const result = state.compareResult;
  if (!result) return null;
  const clashSource = state.clashRawResult ?? state.clashResult;
  const list = state.listResult;
  const listName = state.listDefinitions.find(def => def.id === state.activeListId)?.name ?? '';
  return computeCompareImpact({
    baseModelId: result.baseModelId, headModelId: result.headModelId, entries: result.diff.entries,
    globalIdOf: globalIdReader(state), rowLimit,
    clash: state.clashResult ? { result: state.clashResult, stale: freshness(state, analysisStampOf(clashSource)) } : null,
    validation: state.idsValidationReport
      ? { report: state.idsValidationReport, stale: freshness(state, analysisStampOf(state.idsValidationReport)) } : null,
    // A list result carries no run stamp: its freshness is unknown, never assumed current.
    list: list ? { id: state.activeListId ?? '', name: listName, result: list, stale: null } : null,
    bcfTopics: state.bcfProject ? [...state.bcfProject.topics.values()] : null,
  });
}

/** The current native clash run, unfiltered by review exclusions. */
export function captureClashRun(state: State): CapturedRun | null {
  const result = state.clashRawResult ?? state.clashResult;
  if (!result) return null;
  return { kind: 'clash', id: `clash-run-${crypto.randomUUID()}`, capturedAt: new Date().toISOString(),
    modelIds: gatheredModelIds(result), stamp: analysisStampOf(result), result };
}

export function captureValidationRun(state: State): CapturedRun | null {
  const report = state.idsValidationReport;
  if (!report) return null;
  return { kind: 'validation', id: `validation-run-${crypto.randomUUID()}`, capturedAt: new Date().toISOString(),
    modelIds: report.modelInfo.map(info => info.modelId).sort(), stamp: analysisStampOf(report), report };
}

/** Reconciliation context for the current comparison; null without one. */
export function reconcileContextOf(state: State): ReconcileContext | null {
  const result = state.compareResult;
  if (!result) return null;
  const globalIdOf = globalIdReader(state);
  let headTypes: Map<string, string> | null = null;
  return {
    baseModelId: result.baseModelId,
    headModelId: result.headModelId,
    // The comparison's own head population: an element outside it (deleted,
    // or of an excluded class) is never treated as re-examined.
    headTypeOf: (globalId) => {
      if (!headTypes) {
        headTypes = new Map();
        for (const entry of result.diff.entries) {
          const ref = entry.head?.ref;
          const id = ref ? globalIdOf(ref.modelId, ref.localId) : undefined;
          if (id && entry.head) headTypes.set(id, entry.head.ifcType);
        }
      }
      return headTypes.get(globalId);
    },
    isStale: (run) => isAnalysisStale(run.stamp, staleness(state)),
  };
}

/** Reconcile two captured runs against the current comparison, keeping what a later staleness check needs. */
export function savedReconciliationOf(state: State, base: CapturedRun, head: CapturedRun): SavedReconciliation | null {
  if (!state.compareResult) return null;
  return { outcome: reconcileRuns(base, head, reconcileContextOf(state)), comparison: state.compareResult,
    stamps: base === head ? [base.stamp] : [base.stamp, head.stamp] };
}

/**
 * The saved reconciliation for the current comparison; null for another one.
 * A compatible outcome is `stale` once any reconciled run predates later edits
 * (or has no stamp): its findings then no longer describe the models and must
 * not be shown as current. A refusal names properties of the runs themselves,
 * which a later edit does not make untrue, so it is never stale.
 */
export function currentReconciliationOf(state: ReconciliationState): { outcome: ReconcileOutcome; stale: boolean } | null {
  const saved = state.compareReconciliation;
  if (!saved || !state.compareResult || saved.comparison !== state.compareResult) return null;
  return { outcome: saved.outcome, stale: saved.outcome.ok && saved.stamps.some(stamp => freshness(state, stamp) !== false) };
}
