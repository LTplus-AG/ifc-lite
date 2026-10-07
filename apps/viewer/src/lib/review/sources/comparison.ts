/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Comparison findings: changed elements of the live comparison (current) and
 * rows of saved comparisons (historical). A change that a later comparison no
 * longer lists is not a resolution of anything, so historical rows are
 * `persistent` when the same change is listed now and otherwise `not-evaluated`.
 * Native content matches (renamed, moved, …) are never promoted to identity here.
 */

import type { CompareResult } from '@/store/slices/compareSlice';
import type { SavedComparison } from '../../compare/savedComparisonSchema';
import type { FindingElement, FindingLifecycle, FindingRun, FindingSourceResult, ReviewFinding, ReviewModel, RunGap } from '../types';
import { typeDisciplines } from './disciplines';

export interface ComparisonFindingInput {
  current: { result: CompareResult; stale: boolean } | null;
  saved: readonly SavedComparison[];
}

const pairKey = (base: string, head: string) => `${base}\u001f${head}`;

export function comparisonFindings(input: ComparisonFindingInput, models: readonly ReviewModel[]): FindingSourceResult {
  const runs: FindingRun[] = [];
  const findings: ReviewFinding[] = [];
  const currentLineages = new Set<string>();
  const { current } = input;
  let currentPair: string | null = null;
  if (current) {
    const { result, stale } = current;
    const incomplete: RunGap[] = [
      ...(result.geometryUnavailable && !result.placementOnlyGeometry ? [{ code: 'geometry-unavailable' as const }] : []),
      ...(result.placementOnlyGeometry ? [{ code: 'placement-only' as const }] : []),
      ...(result.diff.excludedTypes.length ? [{ code: 'excluded-classes' as const, detail: result.diff.excludedTypes.join(', ') }] : []),
      ...(stale ? [{ code: 'stale' as const }] : []),
    ];
    currentPair = pairKey(result.baseName, result.headName);
    const run: FindingRun = { id: 'comparison:current', source: 'comparison', temporal: 'current',
      label: `${result.baseName} → ${result.headName}`, capturedAt: null, complete: incomplete.length === 0, incomplete,
      models: [result.baseName, result.headName] };
    runs.push(run);
    const hasSavedPair = input.saved.some(saved => pairKey(saved.report.baseModel, saved.report.headModel) === currentPair);
    for (const entry of result.diff.entries) {
      if (entry.state === 'unchanged') continue;
      const side = entry.state === 'deleted' ? entry.base : entry.head;
      if (!side) continue;
      const model = models.find(candidate => candidate.id === side.ref.modelId);
      const globalId = model?.globalIdOf(side.ref.localId) ?? '';
      const lineage = `comparison|${currentPair}|${globalId || entry.key}|${entry.state}`;
      currentLineages.add(lineage);
      const storey = model?.storeyOf?.(side.ref.localId) ?? null;
      const element: FindingElement = { globalId, modelId: side.ref.modelId, modelName: model?.name ?? null, ifcType: side.ifcType };
      findings.push({ id: `${run.id}#${entry.key}`, lineage, source: 'comparison', run,
        elements: globalId ? [element] : [], nativeStatus: entry.state,
        title: entry.changeKinds.length ? `${side.ifcType}: ${entry.changeKinds.join(', ')}` : side.ifcType,
        detail: entry.changedComponents?.length ? [`changed ${entry.changedComponents.slice(0, 10).join(', ')}`] : [],
        lifecycle: hasSavedPair ? 'new' : 'observed', disciplines: typeDisciplines(side.ifcType),
        storeys: storey ? [storey] : [], evidence: { kind: 'comparison', key: entry.key } });
    }
  }
  for (const saved of input.saved) {
    const { report } = saved;
    const pair = pairKey(report.baseModel, report.headModel);
    const incomplete: RunGap[] = [
      ...(saved.geometryUnavailable && !saved.placementOnlyGeometry ? [{ code: 'geometry-unavailable' as const }] : []),
      ...(saved.placementOnlyGeometry ? [{ code: 'placement-only' as const }] : []),
      ...(report.excludedTypes.length ? [{ code: 'excluded-classes' as const, detail: report.excludedTypes.join(', ') }] : []),
    ];
    const run: FindingRun = { id: `comparison:saved:${saved.id}`, source: 'comparison', temporal: 'historical',
      label: saved.name, capturedAt: report.generatedAt, complete: incomplete.length === 0, incomplete,
      models: [report.baseModel, report.headModel] };
    runs.push(run);
    for (const row of report.rows) {
      if (row.state === 'unchanged' || row.state === 'matched' || !row.globalId) continue;
      const lineage = `comparison|${pair}|${row.globalId}|${row.state}`;
      const persistent = currentLineages.has(lineage);
      const lifecycle: FindingLifecycle = persistent ? 'persistent' : 'not-evaluated';
      if (persistent) for (const item of findings) if (item.lineage === lineage && item.run.temporal === 'current') item.lifecycle = 'persistent';
      findings.push({ id: `${run.id}#${row.globalId}#${row.state}`, lineage, source: 'comparison', run,
        elements: [{ globalId: row.globalId, modelId: null, modelName: row.model, ifcType: row.ifcType, ...(row.name ? { name: row.name } : {}) }],
        nativeStatus: row.state, title: row.change ? `${row.ifcType}: ${row.change}` : row.ifcType, detail: [],
        lifecycle, disciplines: typeDisciplines(row.ifcType), storeys: [],
        evidence: { kind: 'saved-comparison', comparisonId: saved.id, key: row.key ?? row.globalId } });
    }
  }
  return { runs, findings };
}
