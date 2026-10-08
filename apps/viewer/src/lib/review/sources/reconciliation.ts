/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7087: project the native compatible outcome, never reconcile a second time. */
import { clashReviewKey } from '@ifc-lite/clash';
import type { ViewerState } from '@/store';
import { currentReconciliationOf } from '@/lib/compare/compare-analysis-state';
import type { CapturedRun, ReconciledFinding } from '@/lib/compare/run-reconcile-types';
import type { FindingElement, FindingRun, FindingSourceResult, ReviewModel } from '../types';
import { clashGlobalId } from './clash';
import { typeDisciplines } from './disciplines';

function elementsOf(run: CapturedRun | undefined, row: ReconciledFinding, occurrence: string | undefined,
  models: readonly ReviewModel[], historical: boolean): FindingElement[] {
  if (!run || !occurrence) return [];
  const element = (globalId: string, modelId: string, ifcType: string, name?: string): FindingElement => ({
    globalId, modelId: historical ? null : modelId, modelName: models.find(model => model.id === modelId)?.name ?? null,
    ifcType, ...(name ? { name } : {}),
  });
  if (run.kind === 'clash') {
    const matches = run.result.clashes.filter(clash => clash.id === occurrence && clashReviewKey(clash) === row.identity);
    return matches.length === 1 ? [matches[0].a, matches[0].b].map(ref =>
      element(clashGlobalId(ref), ref.model, ref.tag, ref.name)) : [];
  }
  const matches = run.report.specificationResults.flatMap(spec => spec.entityResults.filter(entity =>
    `${entity.modelId}#${entity.expressId}` === occurrence && `${spec.specification.id} ${entity.globalId}` === row.identity));
  return matches.length === 1 && matches[0].globalId ? [element(matches[0].globalId, matches[0].modelId,
    matches[0].entityType, matches[0].entityName)] : [];
}

export function reconciliationFindings(state: ViewerState, models: readonly ReviewModel[]): FindingSourceResult {
  const current = currentReconciliationOf(state);
  if (!current?.outcome.ok) return { runs: [], findings: [] };
  const { outcome, stale } = current;
  const base = state.compareRunCaptures.find(run => run.id === outcome.baseRunId && run.kind === outcome.kind);
  const head = state.compareRunCaptures.find(run => run.id === outcome.headRunId && run.kind === outcome.kind);
  const available = !!base && !!head && [...(base.modelIds ?? []), ...(head.modelIds ?? [])]
    .every(id => models.some(model => model.id === id));
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
    models: [...new Set((run?.modelIds ?? []).flatMap(id => models.find(model => model.id === id)?.name ?? []))],
  });
  const before = owner(base, 'historical'), after = owner(head, 'current');
  return { runs: [before, after], findings: outcome.findings.map(row => {
    const historical = row.state === 'resolved' || !row.headOccurrence;
    const elements = elementsOf(historical ? base : head, row, historical ? row.baseOccurrence : row.headOccurrence, models, historical);
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
