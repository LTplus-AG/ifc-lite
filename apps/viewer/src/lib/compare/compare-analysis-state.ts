/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The store-facing half of comparison impact and run reconciliation (#6921):
 * reads the live viewer state into the pure inputs of `impact.ts` and
 * `run-reconcile.ts`. Nothing here computes a finding.
 */

import type { ViewerState } from '@/store';
import { analysisStampOf, isAnalysisStale } from '@/hooks/useAnalysisStaleness';
import { gatheredModelIds } from '@/lib/clash/federation-identity';
import { computeCompareImpact, type CompareImpact } from './impact';
import type { CapturedRun, ReconcileContext } from './run-reconcile-types';

type State = Pick<ViewerState, 'compareResult' | 'models' | 'clashResult' | 'clashRawResult' | 'idsValidationReport'
  | 'listResult' | 'listDefinitions' | 'activeListId' | 'bcfProject' | 'mutationVersion' | 'geometryContentVersion' | 'modelPlacement'>;

function staleness(state: State) {
  return { mutationVersion: state.mutationVersion, geometryContentVersion: state.geometryContentVersion,
    modelPlacement: state.modelPlacement, models: state.models };
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
    clash: state.clashResult ? { result: state.clashResult, stale: isAnalysisStale(analysisStampOf(clashSource), staleness(state)) } : null,
    validation: state.idsValidationReport
      ? { report: state.idsValidationReport, stale: isAnalysisStale(analysisStampOf(state.idsValidationReport), staleness(state)) } : null,
    // A list result carries no run stamp; its freshness is unknown, never assumed stale.
    list: list ? { id: state.activeListId ?? '', name: listName, result: list, stale: false } : null,
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
