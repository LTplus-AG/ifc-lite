/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { SessionModels, CheckJob } from '@ifc-lite/flow-nodes';
import { resolveTargetModels } from '@ifc-lite/rules';
import { useViewerStore } from '@/store';
import { evaluatorModelsFromState, definedModelTagIdsOf } from '@/lib/model-tags/evaluator-models';
import { runIdsCheck } from '@/lib/validation/run-ids-check';
import { runInformationCheck } from '@/lib/validation/run-information-check';
import { newSavedReport } from '@/lib/validation/reports/history';
import { prepareComparison, comparePreparedPair } from '@/lib/compare/run-comparison';
import { snapshotComparison } from '@/lib/compare/savedComparisons';
import type { DocumentReportResult } from '@/lib/document/build-report-document';
import { retainValidationReport, retainComparisonReport } from './report-retention';
import type { AutomationReportProvenance, AutomationJsonValue } from './report-provenance';
import { checkedModelSet } from './local-models';
import { resolveModels, resolveOneModel } from './model-targets';
import { jobsWithFiles, prepareCheck, type PreparedCheck } from './check-resources';
import { remapRuleTags } from './rule-tag-bindings';
import type { WorkflowRun } from './run-session';

function provenance(run: WorkflowRun, workflowId: string, job: CheckJob, resource: Pick<PreparedCheck, 'name' | 'fingerprint'>, modelIds: readonly string[], session: SessionModels, options?: Record<string, AutomationJsonValue>): AutomationReportProvenance {
  const state = useViewerStore.getState();
  return {
    origin: 'flow', workflowId, runId: run.id, jobId: job.id, resultId: crypto.randomUUID(),
    resource: { name: resource.name, fingerprint: resource.fingerprint }, timestamp: new Date().toISOString(), effectiveOptions: options,
    models: modelIds.map((id) => ({ id, name: state.models.get(id)?.name ?? id,
      sourceFingerprint: session.models.find((model) => model.modelId === id)?.sourceIdentity ?? state.models.get(id)?.sourceContentHash ?? state.models.get(id)?.sourceFingerprint, mutationRevision: state.mutationVersion })),
  };
}
function targets(job: CheckJob, session: SessionModels): Set<string> {
  const state = useViewerStore.getState();
  return new Set(job.targets?.length ? job.targets.flatMap((s) => resolveModels(s, state, session)) : session.models.map((m) => m.modelId));
}

export async function validateChecks(run: WorkflowRun, workflowId: string, modelValue: unknown, jobValue: unknown, files: unknown): Promise<string> {
  const session = checkedModelSet(run, modelValue);
  const results: DocumentReportResult[] = [];
  for (const job of jobsWithFiles(run, jobValue, files)) {
    if (!job.enabled) continue;
    run.progress(`Validation: ${job.id}`);
    const input = await prepareCheck(run, job, 'validation');
    const state = useViewerStore.getState();
    const ids = targets(job, session);
    if (!ids.size) throw new Error(`No validation models for ${job.id}`);
    const retain = ({ report, snapshot }: Awaited<ReturnType<typeof runInformationCheck>>) => {
      checkedModelSet(run, session);
      const metadata = provenance(run, workflowId, job, input, report.modelInfo.map((m) => m.modelId), session);
      const entry = newSavedReport(snapshot, input.name, metadata);
      const retained = retainValidationReport(entry, useViewerStore);
      for (const warning of retained.warnings) run.warn(warning);
      results.push({ jobId: job.id, resultId: metadata.resultId, kind: 'validation', snapshot: entry.snapshot as typeof snapshot });
      if (report.specificationResults.some((s) => s.error)) throw new Error(`${job.id}: evaluator error; completed diagnostic evidence was retained`);
      if (snapshot.summary.checked === 0) run.warn(`${job.id}: no applicable elements were checked; review applicability and model targets`);
      if (snapshot.checks.some((s) => s.setsTruncated)) run.warn(`${job.id}: native validation results were bounded`);
    };
    if (input.kind === 'rules') {
      const ruleSet = remapRuleTags(input.value, job.tagBindings ?? {}, state.modelTags);
      const models = evaluatorModelsFromState(state).filter((m) => ids.has(m.id));
      if (!resolveTargetModels(models, ruleSet.targets).length) throw new Error(`${job.id}: no model matches the native rule set targets`);
      retain(await runInformationCheck({ ruleSet, models, definedModelTagIds: definedModelTagIdsOf(state),
        reportModels: state.models, signal: run.controller.signal }));
    } else if (input.kind === 'ids') {
      for (const id of ids) {
        checkedModelSet(run, session);
        const model = state.models.get(id);
        if (!model?.ifcDataStore) throw new Error(`Missing IDS model ${id}`);
        retain(await runIdsCheck({ document: input.value, modelId: id, dataStore: model.ifcDataStore,
          mutationView: state.getMutationView(id), models: state.models, locale: 'en', signal: run.controller.signal }));
      }
    } else throw new Error('Expected a validation resource');
  }
  return run.put('reports', results);
}

export async function compareChecks(run: WorkflowRun, workflowId: string, modelValue: unknown, jobValue: unknown, files: unknown): Promise<string> {
  const session = checkedModelSet(run, modelValue);
  const results: DocumentReportResult[] = [];
  for (const job of jobsWithFiles(run, jobValue, files)) {
    if (!job.enabled) continue;
    run.progress(`Comparison: ${job.id}`);
    const input = await prepareCheck(run, job, 'comparison');
    if (input.kind !== 'comparison') throw new Error('Expected a comparison recipe');
    const recipe = input.value;
    const state = useViewerStore.getState();
    const allowed = targets(job, session);
    const selectedSession = { ...session, models: session.models.filter((model) => allowed.has(model.modelId)) };
    const base = resolveOneModel(recipe.base, state, selectedSession), head = resolveOneModel(recipe.head, state, selectedSession);
    if (base === head) throw new Error(`${job.id}: base and head must be different models`);
    const baseModel = state.models.get(base), headModel = state.models.get(head);
    if (!baseModel || !headModel) throw new Error('Comparison model was removed');
    const built = await prepareComparison({ baseModel, headModel, getMutationView: state.getMutationView,
      mutationVersion: state.mutationVersion, contentVersion: state.geometryContentVersion,
      keyProperty: recipe.options.keyProperty, signal: run.controller.signal });
    checkedModelSet(run, session);
    const result = comparePreparedPair(built, recipe.options);
    if (recipe.options.scope !== 'data' && (result.geometryUnavailable || result.placementOnlyGeometry)) throw new Error(`${job.id}: full geometry is unavailable; select data scope explicitly`);
    const metadata = provenance(run, workflowId, job, input, [base, head], session, JSON.parse(JSON.stringify({ ...recipe.options, acceptedIdentity: [] })) as Record<string, AutomationJsonValue>);
    const saved = { ...snapshotComparison(result, state.models, recipe.name), automation: metadata };
    const retained = retainComparisonReport(saved, useViewerStore);
    for (const warning of retained.warnings) run.warn(warning);
    results.push({ jobId: job.id, resultId: metadata.resultId, kind: 'comparison', comparison: saved });
  }
  return run.put('reports', results);
}
