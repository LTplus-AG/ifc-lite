/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash findings: the live run is current; the saved revision baseline is
 * historical. Absence is decided by the native `compareClashRevisions`
 * (skipped rules, empty-match rules, lost models and unre-examined elements
 * stay `unretested`), and additionally never from a truncated or stale run.
 */

import { clashReviewKey, compareClashRevisions, type Clash, type ClashElementRef, type ClashResult } from '@ifc-lite/clash';
import { clashDisciplineCandidates } from '../../assistant/clash-taxonomy';
import { manualClashOccurrenceKey } from '../../clash/manual-groups';
import type { FindingElement, FindingLifecycle, FindingRun, FindingSourceResult, ReviewFinding, ReviewModel, RunGap } from '../types';

export interface ClashFindingInput {
  /** The live run with exclusions applied, and whether edits since make it stale. */
  current: { result: ClashResult; stale: boolean } | null;
  /** The saved baseline: its result plus the durable model names of its ephemeral model ids. */
  baseline: { result: ClashResult; modelNames: Readonly<Record<string, string>>; takenAt: number } | null;
}

/** Instanced occurrences fold `:<occurrenceKey>` into the key; GlobalIds never contain ':'. */
export function clashGlobalId(ref: Pick<ClashElementRef, 'key'>): string {
  const at = ref.key.indexOf(':');
  return at < 0 ? ref.key : ref.key.slice(0, at);
}

function ruleLabel(result: ClashResult): string {
  const names = result.rulesRun.map(rule => rule.name).filter(Boolean);
  return names.length ? names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '') : 'Clash detection';
}

function gaps(result: ClashResult, stale: boolean): RunGap[] {
  return [
    ...(result.truncated ? [{ code: 'truncated' as const, detail: result.truncated.reason }] : []),
    ...(stale ? [{ code: 'stale' as const }] : []),
  ];
}

function storeyOf(element: FindingElement, models: readonly ReviewModel[]): string[] {
  const model = models.find(candidate => candidate.id === element.modelId);
  if (!model?.storeyOf) return [];
  const expressId = model.expressIdOf(element.globalId);
  const storey = expressId > 0 ? model.storeyOf(expressId) : null;
  return storey ? [storey] : [];
}

function finding(clash: Clash, run: FindingRun, names: Readonly<Record<string, string>>, models: readonly ReviewModel[],
  lifecycle: FindingLifecycle, historical: boolean): ReviewFinding {
  const element = (ref: ClashElementRef): FindingElement => ({
    globalId: clashGlobalId(ref),
    // A historical model id belonged to an earlier session; only its durable name identifies it now.
    modelId: historical ? null : ref.model,
    modelName: names[ref.model] ?? null,
    ifcType: ref.tag,
    ...(ref.name ? { name: ref.name } : {}),
  });
  const elements = [element(clash.a), element(clash.b)];
  const candidates = clashDisciplineCandidates(clash);
  const reviewKey = clashReviewKey(clash);
  const distance = Number.isFinite(clash.distance) ? `${Number(clash.distance.toPrecision(3))}` : 'n/a';
  return {
    id: `${run.id}#${clash.id}`, lineage: `clash|${reviewKey}`, source: 'clash', run, elements,
    nativeStatus: clash.status, title: `${clash.a.tag} × ${clash.b.tag}`,
    detail: [`rule ${clash.rule}`, `severity ${clash.severity}`, `distance ${distance}${clash.distanceKind ? ` (${clash.distanceKind})` : ''}`],
    lifecycle, disciplines: [...new Set([...candidates.a, ...candidates.b])],
    storeys: [...new Set(elements.flatMap(item => storeyOf(item, models)))],
    evidence: historical ? { kind: 'clash-baseline', reviewKey }
      : { kind: 'clash', clashId: clash.id, occurrenceKey: manualClashOccurrenceKey(clash), reviewKey },
  };
}

export function clashFindings(input: ClashFindingInput, models: readonly ReviewModel[]): FindingSourceResult {
  const liveNames = Object.fromEntries(models.map(model => [model.id, model.name]));
  const runs: FindingRun[] = [];
  const findings: ReviewFinding[] = [];
  const { current, baseline } = input;
  const currentRun: FindingRun | null = current ? {
    id: 'clash:current', source: 'clash', temporal: 'current', label: ruleLabel(current.result), capturedAt: null,
    incomplete: gaps(current.result, current.stale), complete: gaps(current.result, current.stale).length === 0,
    models: [...new Set(current.result.clashes.flatMap(clash => [liveNames[clash.a.model], liveNames[clash.b.model]]).filter(Boolean))],
  } : null;
  const baselineRun: FindingRun | null = baseline ? {
    id: 'clash:baseline', source: 'clash', temporal: 'historical', label: ruleLabel(baseline.result),
    capturedAt: new Date(baseline.takenAt).toISOString(), incomplete: gaps(baseline.result, false),
    complete: !baseline.result.truncated, models: [...new Set(Object.values(baseline.modelNames))],
  } : null;
  const revision = current && baseline ? compareClashRevisions(
    { result: baseline.result, modelNames: baseline.modelNames }, { result: current.result, modelNames: liveNames }) : null;
  const added = new Set(revision?.added.map(clash => clash.id));
  const resolvedIds = new Set(revision?.resolved.map(clash => clash.id));
  const currentLineages = new Set(current?.result.clashes.map(clash => `clash|${clashReviewKey(clash)}`));
  if (current && currentRun) {
    runs.push(currentRun);
    for (const clash of current.result.clashes) {
      const lifecycle: FindingLifecycle = !revision ? 'observed' : added.has(clash.id) ? 'new' : 'persistent';
      findings.push(finding(clash, currentRun, liveNames, models, lifecycle, false));
    }
  }
  if (baseline && baselineRun) {
    runs.push(baselineRun);
    for (const clash of baseline.result.clashes) {
      const lineage = `clash|${clashReviewKey(clash)}`;
      // Only a complete current run may turn native `resolved` into a resolution candidate.
      const lifecycle: FindingLifecycle = currentLineages.has(lineage) ? 'persistent'
        : resolvedIds.has(clash.id) && currentRun?.complete ? 'no-longer-observed' : 'not-evaluated';
      findings.push(finding(clash, baselineRun, baseline.modelNames, models, lifecycle, true));
    }
  }
  return { runs, findings };
}
