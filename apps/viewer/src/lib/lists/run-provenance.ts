/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What produced the stored `listResult` (#6833): the definition that was
 * executed and the analysis stamp taken when its run started. Kept beside the
 * result object (like `stampAnalysisReport`) rather than inferred from
 * `activeListId`, which already names the NEXT list while a run is in flight
 * or after one failed, so it can disagree with the rows on screen.
 */

import type { ListDefinition, ListGrouping, ListResult } from '@ifc-lite/lists';
import { resolveListModelTagScope, scopeModelPairs, type ListModelTagState } from './model-tag-scope';
import type { ModelProviderPair } from './run-list';
import { analysisStampOf, stampAnalysisReport, type AnalysisStamp } from '@/hooks/useAnalysisStaleness';

const runDefinitions = new WeakMap<ListResult, ListDefinition>();
// Presentation can change over retained rows without reconstructing their execution source.
const resultGroupings = new WeakMap<ListResult, ListGrouping | undefined>();
export function listResultGrouping(result: ListResult): ListGrouping | undefined { return resultGroupings.get(result); }
export interface ListRunModels {
  models: readonly { id: string; name: string }[];
  omittedModels: readonly string[];
  /** Nonempty snapshot members whose model is no longer available to name or evaluate. */
  unavailableSnapshotModels: number;
  /** Empty explicit native snapshot is a known absent population; match count alone is not. */
  emptyPopulation: boolean;
}
const runModels = new WeakMap<ListResult, ListRunModels>();
/** Capture the native provider scope, including targeted models without table data. */
export function captureListRunModels(definition: ListDefinition, pairs: readonly ModelProviderPair[],
  state: Omit<ListModelTagState, 'models'> & { models: ReadonlyMap<string, { name: string }> }, legacyName: string): ListRunModels {
  const scoped = scopeModelPairs(definition, pairs, state);
  const resolved = resolveListModelTagScope(definition.modelTagScope, state);
  const available = new Set(scoped.map(pair => pair.modelId));
  const nativeTargets = resolved.kind === 'models' ? [...resolved.modelIds] : state.models.size > 0 ? [...state.models.keys()] : [...available];
  // An all-model snapshot retains selected members even after their model was removed.
  // A model-tag scope still intersects that snapshot with its explicitly resolved models.
  const snapshotTargets = resolved.kind === 'all' ? Object.keys(definition.expressIdsByModel ?? {}) : [];
  const targets = [...new Set([...nativeTargets, ...snapshotTargets])];
  return {
    emptyPopulation: targets.length > 0 && Boolean(definition.expressIdsByModel) && targets.every(id => (definition.expressIdsByModel?.[id] ?? []).length === 0),
    unavailableSnapshotModels: snapshotTargets.filter(id => !state.models.has(id) && !available.has(id)
      && (definition.expressIdsByModel?.[id]?.length ?? 0) > 0).length,
    models: scoped.filter(pair => !definition.expressIdsByModel || (definition.expressIdsByModel[pair.modelId]?.length ?? 0) > 0)
      .map(pair => ({ id: pair.modelId, name: state.models.get(pair.modelId)?.name ?? legacyName })),
    omittedModels: [...state.models].filter(([id]) => !available.has(id)
      && (resolved.kind === 'all' || resolved.kind === 'models' && resolved.modelIds.has(id))
      && (!definition.expressIdsByModel || (definition.expressIdsByModel[id]?.length ?? 0) > 0)).map(([, model]) => model.name),
  };
}
/** Unrecorded scope remains unknown; do not substitute the current model picker. */
export function listRunModels(result: ListResult): ListRunModels | null { return runModels.get(result) ?? null; }

/** Record a freshly executed result: the run-start stamp and the executed definition. */
export function recordListRun(result: ListResult, definition: ListDefinition, stamp: AnalysisStamp, models?: ListRunModels): ListResult {
  runDefinitions.set(result, definition);
  resultGroupings.set(result, definition.grouping);
  if (models) runModels.set(result, { emptyPopulation: models.emptyPopulation, unavailableSnapshotModels: models.unavailableSnapshotModels,
    models: models.models.map(model => ({ ...model })), omittedModels: [...models.omittedModels] });
  return stampAnalysisReport(result, stamp);
}

/**
 * A result re-derived from an existing one (regrouped over the same rows)
 * keeps the original run's stamp: its rows are no fresher than that run.
 */
export function carryListRun(from: ListResult, to: ListResult, definition: ListDefinition): ListResult {
  resultGroupings.set(to, definition.grouping);
  // Regrouping can carry an executed source, but cannot reconstruct an unrecorded one.
  if (runDefinitions.has(from)) runDefinitions.set(to, definition);
  const models = runModels.get(from);
  if (models) runModels.set(to, models);
  const stamp = analysisStampOf(from);
  return stamp ? stampAnalysisReport(to, stamp) : to;
}

/** The executed definition, or null for a result stored without provenance. */
export function listRunDefinition(result: ListResult): ListDefinition | null {
  return runDefinitions.get(result) ?? null;
}
