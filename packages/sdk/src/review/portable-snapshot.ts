/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { buildCards } from './cards.js';
import { reviewValueFits } from './capture-budget.js';
import type { NativeReviewModel } from './capture-types.js';
import type { NativeReviewCaptures } from './native-captures.js';
import { decodeSavedAnalysisRun, type SavedAnalysisRun } from './portable-analysis.js';
import { validateSavedReport, type SavedValidationReport } from './portable-saved-validation.js';
import { analysisBinding, validationBinding } from './portable-bindings.js';
import { withPortableOwners, type PortableOwner } from './portable-native-owners.js';
import { projectPortableAnalysis, projectPortableValidation } from './portable-projection.js';
import { FINDING_SOURCE_KINDS, type FindingSourceKind, type ReviewFinding, type FindingRun, type FindingSourceResult } from './types.js';

export interface PortableReviewRequest {
  sources?: unknown; modelIds?: unknown; maxFindings?: unknown;
  savedAnalysisRuns?: unknown; savedValidationReports?: unknown;
}
function selectors(value: unknown, maximum: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximum || value.some(x => typeof x !== 'string' || x.length > 1_024)) {
    throw new Error('Review selectors must be bounded string arrays');
  }
  return value.slice();
}
function records(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error('Portable Review libraries must be arrays of at most 32 records');
  return value;
}
/** Supplied records remain imported history, even when full source bytes and GUIDs bind.
 * No producer, storage, editor, reconciliation or publication is invoked here.
 */
export async function readPortableReview(captures: NativeReviewCaptures, liveModels: () => readonly NativeReviewModel[],
  request: PortableReviewRequest, allowed: (id: string) => boolean) {
  const selected = selectors(request.sources, 5) ?? [...FINDING_SOURCE_KINDS];
  if (selected.some(x => !FINDING_SOURCE_KINDS.some(kind => kind === x))) throw new Error('Unknown Review source kind');
  const requested = selectors(request.modelIds, 64);
  const cap = request.maxFindings ?? 128;
  if (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 0 || cap > 512) throw new Error('Review row limit must be an integer from 0 to 512');
  const admitted = (id: string) => allowed(id) && (!requested || requested.includes(id));
  const scopedModels = () => liveModels().filter(model => admitted(model.id));
  const empty = (refusal: string) => {
    const cards = buildCards([], []);
    return { origin: 'imported' as const, retention: null, latestAttempt: null, findings: [] as ReviewFinding[], runs: [] as FindingRun[],
      provenance: [], coverage: [], records: [] as Array<{ format: string; value: SavedAnalysisRun | SavedValidationReport }>, bindings: [] as Array<{ id: string; format: string; state: string; refusal: string | null }>,
      cards: cards.cards, totals: cards.totals,
      sources: selected.map(source => ({ source: source as FindingSourceKind, state: source === 'validation' || source === 'clash' ? 'unavailable' : 'unsupported', refusal })),
      bounds: { knownFindings: null as number | null, omittedFindings: null as number | null, rowLimit: cap, textLimit: 512,
        clippedTextFields: 0, knownFindingsScope: 'supplied-historical-records' as const, nativeCoverageComplete: false, presentationComplete: false } };
  };
  if (requested?.some(id => !allowed(id))) return empty('scope');
  if (!reviewValueFits(request)) return empty('work-bound');
  const preflight = captures.portableEvidenceRefusal(request);
  if (preflight) return empty(preflight);
  // Copy after the bounded walk, so caller mutation during source awaits cannot
  // substitute another library for the one admitted at this boundary.
  const frozen = structuredClone(request);
  const analyses: SavedAnalysisRun[] = [], reports: SavedValidationReport[] = [];
  for (const value of records(frozen.savedAnalysisRuns)) {
    const saved = decodeSavedAnalysisRun(value);
    if (!saved) return empty('invalid-record');
    analyses.push(saved);
  }
  for (const value of records(frozen.savedValidationReports)) {
    if (!validateSavedReport(value)) return empty('invalid-record');
    reports.push(value);
  }
  if (analyses.length + reports.length > 32) return empty('work-bound');
  const ids = [...analyses.map(run => `analysis:${run.id}`), ...reports.map(report => `report:${report.id}`)];
  if (new Set(ids).size !== ids.length) return empty('record-ambiguous');
  // A mixed analysis library declares no kind by its mere presence. A typed
  // validation-report collection, including an explicit empty one, does.
  const present = (source: string) => source === 'clash' ? analyses.some(saved => saved.kind === 'clash')
    : source === 'validation' ? analyses.some(saved => saved.kind === 'validation') || frozen.savedValidationReports !== undefined : false;
  const project = (owners: readonly PortableOwner[]) => {
    const findings: ReviewFinding[] = [], runs: FindingRun[] = [], bindings: Array<{ id: string; format: string; state: string; refusal: string | null }> = [];
    const append = (result: FindingSourceResult, format: string, id: string, refusal: string | null) => {
      for (const run of result.runs) runs.push(run);
      for (const finding of result.findings) {
        const identities = finding.elements.map(element => [owners.find(owner => owner.model.id === element.modelId)?.sourceSHA256 ?? null, element.globalId]);
        finding.lineage = JSON.stringify([refusal ? ['unbound-record', format, id] : ['verified-source-elements', identities], finding.lineage]);
        findings.push(finding);
      }
    };
    for (const saved of analyses) {
      if (!selected.includes(saved.kind === 'clash' ? 'clash' : 'validation')) continue;
      const refusal = analysisBinding(saved, owners);
      bindings.push({ id: saved.id, format: 'saved-analysis-run', state: refusal ? 'unbound' : 'bound', refusal });
      const result = projectPortableAnalysis(saved, refusal ? [] : owners);
      append(result, 'saved-analysis-run', saved.id, refusal);
    }
    for (const saved of reports) {
      if (!selected.includes('validation')) continue;
      const refusal = validationBinding(saved, owners);
      bindings.push({ id: saved.id, format: 'saved-validation-report', state: refusal ? 'unbound' : 'bound', refusal });
      const result = projectPortableValidation(saved, refusal ? [] : owners);
      append(result, 'saved-validation-report', saved.id, refusal);
    }
    let clippedTextFields = 0;
    const text = (value: string) => {
      if (value.length <= 512) return value;
      clippedTextFields++;
      const split = value.charCodeAt(511) >= 0xD800 && value.charCodeAt(511) <= 0xDBFF
        && value.charCodeAt(512) >= 0xDC00 && value.charCodeAt(512) <= 0xDFFF;
      return value.slice(0, split ? 511 : 512);
    };
    const inventoryKnown = reports.filter(() => selected.includes('validation')).every(saved =>
      saved.snapshot.kind === 'ids-report' && saved.snapshot.elementEvidence !== undefined);
    const visible = findings.slice(0, cap);
    for (const finding of visible) {
      finding.title = text(finding.title); finding.detail = finding.detail.map(text);
      finding.storeys = finding.storeys.map(text); finding.disciplines = finding.disciplines.map(text);
      for (const element of finding.elements) if (element.name !== undefined) element.name = text(element.name);
    }
    for (const run of runs) {
      run.label = text(run.label);
      for (const gap of run.incomplete) if (gap.detail !== undefined) gap.detail = text(gap.detail);
    }
    const models = owners.map(owner => ({ ...owner.model, sourceIdentity: owner.sourceSHA256,
      expressIdOf: (GlobalId: string) => owner.identities.get(GlobalId) ?? 0,
      globalIdOf: (expressId: number) => owner.GlobalIds.get(expressId) ?? '' }));
    const cards = buildCards(visible, models);
    const response = { ...empty(''), findings: visible, runs, bindings,
      records: [...analyses.filter(saved => selected.includes(saved.kind === 'clash' ? 'clash' : 'validation')).map(value => ({ format: 'saved-analysis-run', value })),
        ...reports.filter(() => selected.includes('validation')).map(value => ({ format: 'saved-validation-report', value }))], cards: cards.cards, totals: cards.totals,
      sources: selected.map(source => ({ source: source as FindingSourceKind, state: source === 'validation' || source === 'clash' ? present(source) ? 'available' : 'not-run' : 'unsupported' })),
      bounds: { knownFindings: inventoryKnown ? findings.length : null, omittedFindings: inventoryKnown ? findings.length - visible.length : null, rowLimit: cap, textLimit: 512,
        clippedTextFields, knownFindingsScope: 'supplied-historical-records' as const, nativeCoverageComplete: false,
        presentationComplete: inventoryKnown && findings.length <= cap && !clippedTextFields } };
    if (!reviewValueFits(response)) return empty('work-bound');
    const final = captures.portableEvidenceRefusal(response);
    return final ? empty(final) : response;
  };
  if (frozen.savedAnalysisRuns === undefined && frozen.savedValidationReports === undefined) return empty('records-unavailable');
  if (!analyses.length && !reports.length) return project([]);
  const result = await withPortableOwners(scopedModels, admitted, project);
  return result.ok ? result.value : empty(result.refusal);
}
