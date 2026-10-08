/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7087: project the native compatible outcome, never reconcile a second time. */
import { clashReviewKey } from '@ifc-lite/clash';
import type { ViewerState } from '@/store';
import { currentReconciliationOf } from '@/lib/compare/compare-analysis-state';
import type { CapturedRun } from '@/lib/compare/run-reconcile-types';
import type { FindingElement, FindingRun, FindingSourceResult, ReviewModel } from '../types';
import { clashGlobalId } from './clash';
import { typeDisciplines } from './disciplines';

/** Index each native occurrence once; large runs must not be rescanned per finding. */
function occurrenceElements(run: CapturedRun | undefined, names: ReadonlyMap<string, string>, historical: boolean) {
  const indexed = new Map<string, FindingElement[] | null>();
  if (!run) return indexed;
  const element = (globalId: string, modelId: string, ifcType: string, name?: string): FindingElement => ({
    globalId, modelId: historical ? null : modelId, modelName: names.get(modelId) ?? null,
    ifcType, ...(name ? { name } : {}),
  });
  const add = (occurrence: string, identity: string, elements: FindingElement[]) => {
    const key = JSON.stringify([occurrence, identity]);
    indexed.set(key, indexed.has(key) ? null : elements); // Duplicate native occurrences have no identity.
  };
  if (run.kind === 'clash') {
    for (const clash of run.result.clashes) add(clash.id, clashReviewKey(clash), [clash.a, clash.b].map(ref =>
      element(clashGlobalId(ref), ref.model, ref.tag, ref.name)));
  } else {
    for (const spec of run.report.specificationResults) for (const entity of spec.entityResults) {
      if (entity.globalId) add(`${entity.modelId}#${entity.expressId}`, `${spec.specification.id} ${entity.globalId}`,
        [element(entity.globalId, entity.modelId, entity.entityType, entity.entityName)]);
    }
  }
  return indexed;
}

export function reconciliationFindings(state: ViewerState, models: readonly ReviewModel[]): FindingSourceResult {
  const current = currentReconciliationOf(state);
  if (!current?.outcome.ok) return { runs: [], findings: [] };
  const { outcome, stale } = current;
  const modelNames = new Map(models.map(model => [model.id, model.name]));
  const base = state.compareRunCaptures.find(run => run.id === outcome.baseRunId && run.kind === outcome.kind);
  const head = state.compareRunCaptures.find(run => run.id === outcome.headRunId && run.kind === outcome.kind);
  const available = !!base && !!head && [...(base.modelIds ?? []), ...(head.modelIds ?? [])]
    .every(id => modelNames.has(id));
  const incomplete = [
    ...(outcome.partial ? [{ code: 'partial-source' as const, detail: 'Native run reconciliation has incomplete evaluation coverage' }] : []),
    ...(outcome.excluded > 0 ? [{ code: 'partial-source' as const, detail: `${outcome.excluded} native findings were excluded from reconciliation` }] : []),
    ...(stale ? [{ code: 'stale' as const }] : []),
    ...(!available ? [{ code: 'partial-source' as const, detail: 'A captured native run is no longer available' }] : []),
  ];
  const owner = (run: CapturedRun | undefined, temporal: FindingRun['temporal']): FindingRun => ({
    id: JSON.stringify(['run-reconciliation', outcome.baseRunId, outcome.headRunId, temporal]), source: 'comparison', temporal,
    label: `${state.compareResult?.baseName ?? ''} → ${state.compareResult?.headName ?? ''}: ${outcome.kind}`,
    capturedAt: run?.capturedAt ?? null, complete: incomplete.length === 0, incomplete,
    models: [...new Set((run?.modelIds ?? []).flatMap(id => modelNames.get(id) ?? []))],
  });
  const before = owner(base, 'historical'), after = owner(head, 'current');
  const beforeElements = occurrenceElements(base, modelNames, true), afterElements = occurrenceElements(head, modelNames, false);
  return { runs: [before, after], findings: outcome.findings.map(row => {
    const historical = row.state === 'resolved' || !row.headOccurrence;
    const occurrence = historical ? row.baseOccurrence : row.headOccurrence;
    const elements = (historical ? beforeElements : afterElements).get(JSON.stringify([occurrence, row.identity])) ?? [];
    const identified = available && elements.length > 0;
    const run = historical ? before : after;
    return { id: JSON.stringify([run.id, row.identity]), lineage: JSON.stringify(['run-reconciliation', outcome.kind, row.identity]),
      source: 'comparison', run, elements, nativeStatus: row.state, title: row.label,
      detail: [...(row.reason ? [row.reason] : []), ...(row.changes ?? []), ...(!identified ? ['Native occurrence unavailable or ambiguous'] : [])],
      lifecycle: !identified || stale || row.state === 'notEvaluated' ? 'not-evaluated'
        : row.state === 'resolved' ? after.complete ? 'no-longer-observed' : 'not-evaluated'
        : row.state === 'new' ? 'new' : 'persistent',
      disciplines: [...new Set(elements.flatMap(element => element.ifcType ? typeDisciplines(element.ifcType) : []))], storeys: [],
      evidence: { kind: 'run-reconciliation', baseRunId: outcome.baseRunId, headRunId: outcome.headRunId, identity: row.identity },
    };
  }) };
}
