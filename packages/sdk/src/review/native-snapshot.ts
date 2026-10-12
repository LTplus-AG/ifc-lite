/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { buildCards } from './cards.js';
import { FINDING_SOURCE_KINDS, type FindingSourceKind } from './types.js';
import type { NativeReviewModel, NativeReviewResult } from './capture-types.js';
import type { NativeReviewCaptures } from './native-captures.js';

function selectors(value: unknown, maximum: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximum || value.some(x => typeof x !== 'string' || x.length > 1_024)) {
    throw new Error('Review selectors must be bounded string arrays');
  }
  return value.slice();
}

/** One bounded read projection used by actual Flow and MCP dispatch. */
export async function readNativeReview(captures: NativeReviewCaptures, liveModels: () => readonly NativeReviewModel[],
  request: { sources?: unknown; modelIds?: unknown; maxFindings?: unknown }, allowed: (id: string) => boolean) {
  const selected = selectors(request.sources, 5) ?? [...FINDING_SOURCE_KINDS];
  if (selected.some(x => !FINDING_SOURCE_KINDS.some(kind => kind === x))) throw new Error('Unknown Review source kind');
  const requested = selectors(request.modelIds, 64);
  if (requested?.some(id => !allowed(id))) throw new Error('A requested Review model is outside the caller scope');
  const cap = request.maxFindings ?? 128;
  if (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 0 || cap > 512) throw new Error('Review row limit must be an integer from 0 to 512');
  const selectedModel = (id: string) => !requested || requested.includes(id);
  const admitted = (id: string) => allowed(id) && selectedModel(id);
  const scopedModels = () => liveModels().filter(model => admitted(model.id));
  let scoped = scopedModels();
  if (scoped.length > 64) throw new Error('Review model enumeration exceeds the work bound');
  // Projection runs synchronously inside the final capture revalidation, so
  // no promise continuation can change ownership between proof and envelope.
  const project = (native: NativeReviewResult | null) => {
    scoped = scopedModels();
    if (native && (native.provenance.some(run => run.sources.some(source => !admitted(source.modelId)))
      || native.latestAttempt?.proof?.sources.some(source => !admitted(source.modelId)))) {
      native.runs = []; native.findings = []; native.provenance = []; native.coverage = []; native.latestAttempt = null;
      native.availability = 'unavailable'; native.refusal = 'scope';
    }
    const findings = native?.findings.slice(0, cap) ?? [];
    // Presentation text is bounded independently of exact native identity/counts.
    let clippedTextFields = 0;
    const text = (value: string) => {
      if (value.length <= 512) return value;
      clippedTextFields++;
      // Keep the UTF-16 work bound without leaving half of an actual pair.
      const high = value.charCodeAt(511), low = value.charCodeAt(512);
      const end = high >= 0xD800 && high <= 0xDBFF && low >= 0xDC00 && low <= 0xDFFF ? 511 : 512;
      return value.slice(0, end);
    };
    for (const finding of findings) {
      finding.title = text(finding.title); finding.detail = finding.detail.map(text);
      finding.storeys = finding.storeys.map(text); finding.disciplines = finding.disciplines.map(text);
      for (const element of finding.elements) if (element.name !== undefined) element.name = text(element.name);
    }
    for (const run of native?.runs ?? []) {
      run.label = text(run.label);
      for (const gap of run.incomplete) if (gap.detail !== undefined) gap.detail = text(gap.detail);
    }
    const cards = buildCards(findings, scoped);
    const sources = selected.map(source => ({ source: source as FindingSourceKind,
      state: source === 'validation' ? native?.availability ?? 'not-run' : 'unsupported',
      ...(source === 'validation' && native?.refusal ? { refusal: native.refusal } : {}) }));
    const known = native && native.availability === 'available' ? native.findings.length : null;
    const response = { retention: native?.retention ?? null, latestAttempt: native?.latestAttempt ?? null, findings, runs: native?.runs ?? [], provenance: native?.provenance ?? [], coverage: native?.coverage ?? [],
      cards: cards.cards, totals: cards.totals, sources,
      bounds: { knownFindings: known, omittedFindings: known === null ? null : known - findings.length,
        rowLimit: cap, textLimit: 512, clippedTextFields, knownFindingsScope: 'retained-current-contexts' as const,
        nativeCoverageComplete: native?.availability === 'available' && !native.retention?.inventoryOmitted && native.runs.length > 0 && native.runs.every(run => run.complete),
        presentationComplete: native?.availability === 'available' && native.findings.length <= cap && !clippedTextFields } };
    // Card projection also reads current display metadata. Check that final
    // envelope, not only the original captured rows, before returning it.
    if (!captures.acceptsEvidence(response)) {
      const empty = buildCards([], []);
      return { retention: null, latestAttempt: null, findings: [], runs: [], provenance: [], coverage: [], cards: empty.cards, totals: empty.totals,
        sources: selected.map(source => ({ source: source as FindingSourceKind,
          state: source === 'validation' ? 'unavailable' : 'unsupported',
          ...(source === 'validation' ? { refusal: native?.refusal ?? 'sensitive-input' } : {}) })),
        bounds: { knownFindings: null, omittedFindings: null, rowLimit: cap, textLimit: 512, clippedTextFields: 0, knownFindingsScope: 'retained-current-contexts' as const,
          nativeCoverageComplete: false, presentationComplete: false } };
    }
    return response;
  };
  return selected.includes('validation') ? captures.read(liveModels, allowed, project, selectedModel) : project(null);
}
