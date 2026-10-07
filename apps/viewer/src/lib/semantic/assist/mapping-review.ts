/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assertIri, type ProfileDefinition } from '@ifc-lite/semantic';
import { useViewerStore } from '@/store';
import { createQueryAdapter } from '@/sdk/adapters/query-adapter';
import type { StoreApi } from '@/sdk/adapters/types';
import type { ProposedMapping, SemanticMappingProposal } from './mapping-proposal';
import type { SourceSpan } from './proposal-common';
import { verifySpan, type Passage, type SpanCheck } from './spans';

export type TermMatch = { status: 'profile'; key: string; iri: string } | { status: 'external'; iri: string } | { status: 'unknown' };
/** Profile keys or IRIs resolve to the native profile; other absolute IRIs stay external, anything else is unknown. */
export function matchTerm(term: string, entries: Record<string, { iri: string }>): TermMatch {
  for (const [key, entry] of Object.entries(entries)) if (key === term || entry.iri === term) return { status: 'profile', key, iri: entry.iri };
  try { assertIri(term); return { status: 'external', iri: term }; }
  catch { return { status: 'unknown' }; }
}

export type MappingIssue = 'unknown-term' | 'span-mismatch' | 'span-not-captured' | 'external-term' | 'class-absent' | 'unsourced';
export const BLOCKING_ISSUES: ReadonlySet<MappingIssue> = new Set(['unknown-term', 'span-mismatch', 'span-not-captured']);
export interface MappingRow {
  mapping: ProposedMapping; elements: number; classTerm?: TermMatch; propertyTerm?: TermMatch;
  spans: Array<{ span: SourceSpan; check: SpanCheck }>; issues: MappingIssue[]; approvable: boolean;
}
export interface MappingReview { modelId: string | null; rows: MappingRow[] }

/** Check every mapping against the live model scope, the current profile and the captured passages. */
export function reviewSemanticMapping(proposal: SemanticMappingProposal, input: {
  profile: ProfileDefinition; revisions: ReadonlyMap<string, string>; passages: readonly Passage[]; store?: StoreApi;
}): MappingReview {
  const store = input.store ?? useViewerStore;
  const associated = input.revisions.get(proposal.modelRevision);
  const modelId = associated && store.getState().models.has(associated) ? associated : null;
  const query = createQueryAdapter(input.store ?? useViewerStore);
  const counts = new Map<string, number>();
  const rows = proposal.mappings.map((mapping): MappingRow => {
    if (!counts.has(mapping.ifc.class)) {
      counts.set(mapping.ifc.class, modelId ? query.entities({ types: [mapping.ifc.class] }).filter(entity => entity.ref.modelId === modelId).length : 0);
    }
    const elements = counts.get(mapping.ifc.class) ?? 0;
    const classTerm = mapping.ontology.class === undefined ? undefined : matchTerm(mapping.ontology.class, input.profile.types);
    const propertyTerm = mapping.ontology.property === undefined ? undefined : matchTerm(mapping.ontology.property, input.profile.fields);
    const spans = mapping.sources.map(span => ({ span, check: verifySpan(span, input.passages) }));
    const issues: MappingIssue[] = [];
    if ([classTerm, propertyTerm].some(term => term?.status === 'unknown')) issues.push('unknown-term');
    if (spans.some(({ check }) => check.status === 'mismatch')) issues.push('span-mismatch');
    if (spans.some(({ check }) => check.status === 'not-captured')) issues.push('span-not-captured');
    if ([classTerm, propertyTerm].some(term => term?.status === 'external')) issues.push('external-term');
    if (!elements) issues.push('class-absent');
    if (!spans.length) issues.push('unsourced');
    return { mapping, elements, classTerm, propertyTerm, spans, issues, approvable: !!modelId && !issues.some(issue => BLOCKING_ISSUES.has(issue)) };
  });
  return { modelId, rows };
}
