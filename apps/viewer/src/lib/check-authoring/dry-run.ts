/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dry run of a drafted check (#6915) against the loaded models, through the
 * same native services the Data validation panel uses (`runIdsCheck`,
 * `runInformationCheck`), WITHOUT publishing a report, recolouring the scene
 * or touching the definition library. Counts are the native engine's own;
 * samples keep their model identity so the review can show them in the model.
 */

import type { IDSDocument, SpecificationResult } from '@ifc-lite/ids';
import type { RuleSetFile } from '@ifc-lite/rules';
import { useViewerStore } from '@/store';
import { captureAnalysisStamp, isAnalysisStale, type AnalysisStamp } from '@/hooks/useAnalysisStaleness';
import { isNativeWorkflowBusy } from '../flow/run-session';
import { evaluatorModelsFromState, definedModelTagIdsOf } from '../model-tags/evaluator-models';
import { runIdsCheck } from '../validation/run-ids-check';
import { runInformationCheck } from '../validation/run-information-check';

export const SAMPLE_FAILURES = 5;

export interface DryRunFailure {
  modelId: string;
  expressId: number;
  entityType: string;
  name?: string;
  globalId?: string;
  reason?: string;
}

/** One specification or rule, summed over every checked model. */
export interface DryRunCheck {
  id: string;
  name: string;
  severity?: 'error' | 'warning';
  applicable: number;
  passed: number;
  failed: number;
  /** Cardinality verdicts per model (IDS runs each model separately). */
  cardinality: Array<{ modelId: string; passed: boolean; message: string }>;
  /** Failing uniqueness/aggregate sets (information rules only). */
  failedSets: number;
  /** The engine could not evaluate the check. */
  errors: string[];
  failures: DryRunFailure[];
}

export interface DryRun {
  kind: 'ids' | 'rules';
  /** Exact JSON of the checked definition; any edit makes the run stale. */
  subject: string;
  stamp: AnalysisStamp;
  models: ReadonlyMap<string, unknown>;
  checkedModels: string[];
  /** Loaded models without parsed data, which nothing could check. */
  skippedModels: string[];
  checks: DryRunCheck[];
}

function addResult(checks: DryRunCheck[], index: number, result: SpecificationResult): void {
  const check = checks[index] ??= { id: result.specification.id, name: result.specification.name,
    ...(result.specification.severity ? { severity: result.specification.severity } : {}),
    applicable: 0, passed: 0, failed: 0, cardinality: [], failedSets: 0, errors: [], failures: [] };
  check.applicable += result.applicableCount;
  check.passed += result.passedCount;
  check.failed += result.failedCount;
  check.failedSets += (result.setResults ?? []).filter(set => !set.passed).length;
  if (result.error) check.errors.push(result.error);
  for (const entity of result.entityResults) {
    if (entity.passed || check.failures.length >= SAMPLE_FAILURES) continue;
    const failing = entity.requirementResults.find(requirement => requirement.status === 'fail');
    check.failures.push({ modelId: entity.modelId, expressId: entity.expressId, entityType: entity.entityType,
      ...(entity.entityName ? { name: entity.entityName } : {}), ...(entity.globalId ? { globalId: entity.globalId } : {}),
      ...(failing ? { reason: failing.failureReason ?? failing.checkedDescription } : {}) });
  }
}

function begin(kind: DryRun['kind'], subject: unknown): DryRun {
  if (isNativeWorkflowBusy()) throw new Error('A workflow is running; wait or cancel it before a dry run.');
  const state = useViewerStore.getState();
  if (state.models.size === 0) throw new Error('Load a model to dry-run the draft.');
  // A run over models without parsed data would check nothing and still look complete.
  if (![...state.models.values()].some(model => model.ifcDataStore)) throw new Error('No loaded model has parsed data to dry-run the draft on.');
  return { kind, subject: JSON.stringify(subject), stamp: captureAnalysisStamp(), models: state.models,
    checkedModels: [], skippedModels: [], checks: [] };
}

/** Each loaded model is validated separately, as the native IDS panel does; counts are summed per specification. */
export async function dryRunIds(document: IDSDocument, signal?: AbortSignal): Promise<DryRun> {
  const run = begin('ids', document);
  const state = useViewerStore.getState();
  for (const [modelId, model] of state.models) {
    if (!model.ifcDataStore) { run.skippedModels.push(modelId); continue; }
    const { report } = await runIdsCheck({ document, modelId, dataStore: model.ifcDataStore, mutationView: state.getMutationView(modelId),
      locale: state.idsLocale, models: state.models, signal });
    run.checkedModels.push(modelId);
    report.specificationResults.forEach((result, index) => {
      addResult(run.checks, index, result);
      if (result.cardinalityResult) run.checks[index].cardinality.push({ modelId, passed: result.cardinalityResult.passed, message: result.cardinalityResult.message });
    });
  }
  return run;
}

/** One native rule-engine run over every loaded model (rules address the federation). */
export async function dryRunRules(ruleSet: RuleSetFile, signal?: AbortSignal): Promise<DryRun> {
  const run = begin('rules', ruleSet);
  const state = useViewerStore.getState();
  const { report } = await runInformationCheck({ ruleSet, models: evaluatorModelsFromState(state),
    definedModelTagIds: definedModelTagIdsOf(state), reportModels: state.models, signal });
  for (const [modelId, model] of state.models) (model.ifcDataStore ? run.checkedModels : run.skippedModels).push(modelId);
  report.specificationResults.forEach((result, index) => addResult(run.checks, index, result));
  return run;
}

/** A dry run authorises saving only for the same definition on unchanged models, and only if it checked one. */
export function isDryRunCurrent(run: DryRun | null, subject: unknown): run is DryRun {
  if (!run || run.checkedModels.length === 0) return false;
  const state = useViewerStore.getState();
  return run.subject === JSON.stringify(subject) && run.models === state.models && !isAnalysisStale(run.stamp, state);
}
