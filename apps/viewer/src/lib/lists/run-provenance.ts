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

import type { ListDefinition, ListResult } from '@ifc-lite/lists';
import { resolveListModelTagScope, scopeModelPairs, type ListModelTagState } from './model-tag-scope';
import type { ModelProviderPair } from './run-list';
import { analysisStampOf, stampAnalysisReport, type AnalysisStamp } from '@/hooks/useAnalysisStaleness';

const runDefinitions = new WeakMap<ListResult, ListDefinition>();
export interface ListRunModels {
  models: readonly { id: string; name: string }[];
  omittedModels: readonly string[];
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
  const targets = resolved.kind === 'models' ? [...resolved.modelIds] : state.models.size > 0 ? [...state.models.keys()] : [...available];
  return {
    emptyPopulation: Boolean(definition.expressIdsByModel) && targets.every(id => (definition.expressIdsByModel?.[id] ?? []).length === 0),
    models: scoped.map(pair => ({ id: pair.modelId, name: state.models.get(pair.modelId)?.name ?? legacyName })),
    omittedModels: [...state.models].filter(([id]) => !available.has(id)
      && (resolved.kind === 'all' || resolved.kind === 'models' && resolved.modelIds.has(id))).map(([, model]) => model.name),
  };
}
/** Unrecorded scope remains unknown; do not substitute the current model picker. */
export function listRunModels(result: ListResult): ListRunModels | null { return runModels.get(result) ?? null; }

/** Record a freshly executed result: the run-start stamp and the executed definition. */
export function recordListRun(result: ListResult, definition: ListDefinition, stamp: AnalysisStamp, models?: ListRunModels): ListResult {
  runDefinitions.set(result, definition);
  if (models) runModels.set(result, { emptyPopulation: models.emptyPopulation, models: models.models.map(model => ({ ...model })), omittedModels: [...models.omittedModels] });
  return stampAnalysisReport(result, stamp);
}

/**
 * A result re-derived from an existing one (regrouped over the same rows)
 * keeps the original run's stamp: its rows are no fresher than that run.
 */
export function carryListRun(from: ListResult, to: ListResult, definition: ListDefinition): ListResult {
  runDefinitions.set(to, definition);
  const models = runModels.get(from);
  if (models) runModels.set(to, models);
  const stamp = analysisStampOf(from);
  return stamp ? stampAnalysisReport(to, stamp) : to;
}

/** The executed definition, or null for a result stored without provenance. */
export function listRunDefinition(result: ListResult): ListDefinition | null {
  return runDefinitions.get(result) ?? null;
}
