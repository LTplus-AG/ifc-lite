/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { runRuleSet, type EvaluatorModel, type RuleSetFile, type RuleEngineProgress } from '@ifc-lite/rules';
import { materializeEffectiveIfcStore } from '@/lib/effective-ifc-store';
import { validationReportSnapshot, type ReportScopeModel } from './reports/history';
import { throwIfCheckAborted } from './run-ids-check';
import { recordReportRuleSet, ruleSetContentOf } from './report-rule-set';

export interface RunInformationCheckOptions {
  ruleSet: RuleSetFile;
  /** Explicit job model set; native targets may narrow it further. */
  models: readonly EvaluatorModel[];
  definedModelTagIds?: ReadonlySet<string>;
  reportModels: ReadonlyMap<string, ReportScopeModel>;
  signal?: AbortSignal;
  onProgress?: (progress: RuleEngineProgress) => void;
  snapshotId?: string;
}

/** Shared native rule-set execution, with no store publication or UI effects. */
export async function runInformationCheck(options: RunInformationCheckOptions) {
  throwIfCheckAborted(options.signal);
  const content = ruleSetContentOf(options.ruleSet);
  const reportModels =new Map([...options.reportModels].map(([id, model]) => [id, { ...model }]));
  const models: EvaluatorModel[] = [];
  for (const model of options.models) {
    throwIfCheckAborted(options.signal);
    if (!model.store || !model.mutationView?.hasPendingChanges()) {
      models.push(model);
      continue;
    }
    // Requirement subjects read the parsed store. Bake the existing canonical
    // mutation export once so applicability AND every requirement see the same
    // effective names, attributes, quantities, properties and entity set.
    const sourceSchema = model.store.schemaVersion;
    const schema = sourceSchema === 'IFC2X3' || sourceSchema === 'IFC4X3' || sourceSchema === 'IFC5' ? sourceSchema : 'IFC4';
    const store = await materializeEffectiveIfcStore(model.store, model.mutationView, schema);
    throwIfCheckAborted(options.signal);
    if (store === model.store) throw new Error(`Cannot validate edited model ${model.id}: canonical STEP mutation export is unavailable`);
    models.push({ ...model, store, mutationView: undefined });
  }
  const report = await runRuleSet({
    ruleSet: options.ruleSet, models,
    definedModelTagIds: options.definedModelTagIds, signal: options.signal,
    onProgress: (progress) => { if (!options.signal?.aborted) options.onProgress?.(progress); },
  });
  throwIfCheckAborted(options.signal);
  recordReportRuleSet(report, content);
  for (const model of models) {
    const scope = reportModels.get(model.id);
    if (scope) reportModels.set(model.id, { ...scope, ifcDataStore: model.store });
  }
  return { report, snapshot: validationReportSnapshot(report, reportModels, options.snapshotId ?? 'run') };
}
