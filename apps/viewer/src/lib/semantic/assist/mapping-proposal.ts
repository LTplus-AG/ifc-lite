/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { assertIri, type ProfileDefinition } from '@ifc-lite/semantic';
import { useViewerStore } from '@/store';
import { createQueryAdapter } from '@/sdk/adapters/query-adapter';
import type { StoreApi } from '@/sdk/adapters/types';
import { onlyKeys, parseEnvelope, parseSpan, parseUnsupported, record, text, type SourceSpan, type UnsupportedItem } from './proposal-common';
import { verifySpan, type Passage, type SpanCheck } from './spans';

export interface IfcSide { class: string; pset?: string; property?: string }
export interface OntologySide { class?: string; property?: string }
export interface ProposedMapping { ifc: IfcSide; ontology: OntologySide; confidence: number; rationale?: string; sources: SourceSpan[] }
export interface SemanticMappingProposal {
  version: 1; kind: 'semantic.mapping'; title: string;
  /** The semantic revision identifier these mappings were drafted for; must be associated with a loaded model. */
  modelRevision: string;
  mappings: ProposedMapping[]; unsupported: UnsupportedItem[];
}

const IFC_CLASS = /^Ifc[A-Za-z0-9]{1,80}$/;

function ifcSide(value: unknown, at: string): IfcSide {
  if (!record(value)) throw new Error(`${at} needs an "ifc" object`);
  onlyKeys(value, ['class', 'pset', 'property'], `${at} ifc`);
  if (typeof value.class !== 'string' || !IFC_CLASS.test(value.class)) throw new Error(`${at} needs an IFC class such as "IfcDoor"`);
  if ((value.pset === undefined) !== (value.property === undefined)) throw new Error(`${at} needs both a property set and a property, or neither`);
  if (value.pset !== undefined && (!text(value.pset, 120) || !text(value.property, 120))) throw new Error(`${at} property names must be text`);
  return { class: value.class, ...(value.pset === undefined ? {} : { pset: value.pset as string, property: value.property as string }) };
}

function ontologySide(value: unknown, at: string, ifc: IfcSide): OntologySide {
  if (!record(value)) throw new Error(`${at} needs an "ontology" object`);
  onlyKeys(value, ['class', 'property'], `${at} ontology`);
  if (value.class === undefined && value.property === undefined) throw new Error(`${at} must name an ontology class or property`);
  if (value.class !== undefined && !text(value.class, 1000)) throw new Error(`${at} ontology class must be text`);
  if (value.property !== undefined && !text(value.property, 1000)) throw new Error(`${at} ontology property must be text`);
  if ((value.property === undefined) !== (ifc.property === undefined)) throw new Error(`${at} must map a property to a property, or a class to a class`);
  return { ...(value.class === undefined ? {} : { class: value.class as string }), ...(value.property === undefined ? {} : { property: value.property as string }) };
}

export function parseSemanticMapping(answer: string): SemanticMappingProposal {
  const value = parseEnvelope(answer, 'semantic.mapping', ['modelRevision', 'mappings', 'unsupported']);
  if (!text(value.modelRevision, 2000)) throw new Error('A mapping proposal must name the model revision it was drafted for');
  if (!Array.isArray(value.mappings) || !value.mappings.length || value.mappings.length > 200) throw new Error('A mapping proposal needs 1 to 200 mappings');
  const keys = new Set<string>();
  const mappings = value.mappings.map((item, index): ProposedMapping => {
    const at = `Mapping ${index + 1}`;
    if (!record(item)) throw new Error(`${at} is not an object`);
    onlyKeys(item, ['ifc', 'ontology', 'confidence', 'rationale', 'sources'], at);
    const ifc = ifcSide(item.ifc, at);
    const ontology = ontologySide(item.ontology, at, ifc);
    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) {
      throw new Error(`${at} needs a confidence between 0 and 1`);
    }
    if (item.rationale !== undefined && !text(item.rationale, 1000)) throw new Error(`${at} rationale must be text`);
    if (item.sources !== undefined && (!Array.isArray(item.sources) || item.sources.length > 10)) throw new Error(`${at} sources must be a list of at most 10 spans`);
    const sources = ((item.sources ?? []) as unknown[]).map((span, spanIndex) => parseSpan(span, `${at} source ${spanIndex + 1}`));
    const key = JSON.stringify([ifc.class, ifc.pset ?? null, ifc.property ?? null, ontology.class ?? null, ontology.property ?? null]);
    if (keys.has(key)) throw new Error(`${at} repeats an earlier mapping`);
    keys.add(key);
    return { ifc, ontology, confidence: item.confidence, ...(item.rationale === undefined ? {} : { rationale: item.rationale as string }), sources };
  });
  return { version: 1, kind: 'semantic.mapping', title: (value.title as string).trim(), modelRevision: value.modelRevision, mappings,
    unsupported: parseUnsupported(value.unsupported) };
}

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
  const modelId = input.revisions.get(proposal.modelRevision) ?? null;
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
