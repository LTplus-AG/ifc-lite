/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Deterministic synthetic fixtures for the review workspace tests (P18, #6922). */

import { summarizeClashes, type Clash, type ClashResult } from '@ifc-lite/clash';
import type { FindingElement, FindingRun, ReviewFinding, ReviewModel } from './types';

/** A model whose express ids are 1-based positions in `globalIds`; storeys come from `storeys[globalId]`. */
export function fakeModel(id: string, name: string, globalIds: readonly string[], storeys: Record<string, string> = {}): ReviewModel {
  return {
    id, name,
    expressIdOf: globalId => globalIds.indexOf(globalId) + 1,
    globalIdOf: expressId => globalIds[expressId - 1] ?? '',
    storeyOf: expressId => storeys[globalIds[expressId - 1] ?? ''] ?? null,
  };
}

export function clash(id: string, a: { guid: string; model: string; tag: string }, b: { guid: string; model: string; tag: string },
  overrides: Partial<Clash> = {}): Clash {
  return {
    id, rule: 'arch-vs-mep', status: 'hard', severity: 'major', distance: -0.02, distanceKind: 'mesh',
    a: { key: a.guid, ref: 1, model: a.model, tag: a.tag }, b: { key: b.guid, ref: 2, model: b.model, tag: b.tag },
    point: [0, 0, 0], bounds: { min: [0, 0, 0], max: [1, 1, 1] }, ...overrides,
  };
}

export function clashResult(clashes: Clash[], extra: Partial<ClashResult> = {}): ClashResult {
  return { clashes, summary: summarizeClashes(clashes),
    rulesRun: [{ id: 'arch-vs-mep', name: 'Arch vs MEP', a: 'IfcWall', b: 'IfcPipeSegment', mode: 'hard' }],
    settings: { tolerance: 0.002, excludeVoidsAndHosts: true }, ...extra };
}

export const element = (globalId: string, modelName: string | null = 'arch.ifc', modelId: string | null = null): FindingElement =>
  ({ globalId, modelId, modelName, ifcType: 'IfcWall' });

export function run(id: string, source: FindingRun['source'], overrides: Partial<FindingRun> = {}): FindingRun {
  return { id, source, temporal: 'current', label: id, capturedAt: null, complete: true, incomplete: [], models: [], ...overrides };
}

export function finding(id: string, source: FindingRun['source'], elements: FindingElement[], overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  const owner = overrides.run ?? run(`${source}:current`, source);
  return { id: `${owner.id}#${id}`, lineage: `${source}|${id}`, source, run: owner, elements, nativeStatus: 'x', title: id, detail: [],
    lifecycle: 'observed', disciplines: [], storeys: [], evidence: { kind: 'linked', resourceId: id }, ...overrides };
}

/** Native selector coverage: the durable keys rule `arch-vs-mep` re-examined on each side. */
export const covering = (a: string[], b: string[]): Partial<ClashResult> => ({
  ruleCoverage: [{ rule: 'arch-vs-mep', matchedA: a.length, matchedB: b.length, matchedKeysA: a, matchedKeysB: b }],
});
