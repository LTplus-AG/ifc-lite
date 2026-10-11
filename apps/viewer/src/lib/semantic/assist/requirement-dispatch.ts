/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dispatch of reviewed source requirements into the native P07 drafts
 * (#7375): IDS specifications, information rules and a manual-review
 * document. Every draft is written as the P07 proposal JSON and read back by
 * the same strict parsers an assistant answer goes through, so the native
 * audit, dry run, save and editor handoff of the P07 review cards apply
 * unchanged. Each native record carries its requirement id, statement, stated
 * unit and exact source span with the source revision, inside the record
 * itself (IDS instructions, rule description, document item), so the linkage
 * survives saving, export and reload. Nothing runs or saves here.
 */

import { parseIdsProposal, type IdsProposal } from '@/lib/check-authoring/ids-proposal';
import { parseRulesProposal, type RulesProposal } from '@/lib/check-authoring/rules-proposal';
import { parseDocumentOutline, type DocumentOutline } from '@/lib/check-authoring/document-outline';
import { unitFactor } from '@/lib/check-authoring/ids-constraint';
import type { ExtractedRequirement, SemanticRequirementProposal } from './requirement-proposal';
import type { RequirementReview } from './requirement-review';
import type { SourceText } from './source-texts';
import type { Passage } from './spans';
import { classifyRequirement, measureUnit, propertyTarget, sourceRevisionOf, type ClassifiedRequirement, type SourceRevision, type UnresolvedReason } from './requirement-targets';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Stored with the native record, in English like the other P07 record notes. */
export function provenanceNote(requirement: ExtractedRequirement, source: SourceRevision): string {
  const { span, unit } = requirement;
  return `Source requirement ${requirement.id} from ${source.source} "${source.title}" (revision ${source.revision}, ${source.characters} characters), `
    + `characters ${span.start}-${span.end}: "${span.quote}"${unit ? `. Stated unit: ${unit}` : ''}.`;
}

const UNRESOLVED_NOTE: Record<UnresolvedReason, string> = {
  span: 'its source quote does not match the attached text',
  'source-missing': 'its source text is no longer attached',
  'source-changed': 'its source text changed after the assistant read it',
  property: 'the property is not named as PropertySet.Property or an IFC attribute',
  operator: 'no native check expresses this comparison',
  value: 'the value does not fit the comparison',
  unit: 'the stated unit cannot be converted natively',
  native: 'the native validator refused it',
};

const specName = (requirement: ExtractedRequirement) => clip(`${requirement.id}: ${requirement.statement}`, 200);

function idsValue(requirement: ExtractedRequirement): Record<string, unknown> {
  const { value, unit } = requirement;
  const measure = unit !== undefined && requirement.operator !== 'exists' ? measureUnit(unit) : null;
  const typed = measure ? { dataType: measure.dataType, unit: measure.unit } : typeof value === 'boolean' ? { dataType: 'IFCBOOLEAN' } : {};
  switch (requirement.operator ?? 'exists') {
    case 'exists': return {};
    case 'oneOf': return { ...typed, value: { type: 'enumeration', values: value } };
    case 'matches': return { value: { type: 'pattern', pattern: value } };
    case 'atLeast': return { ...typed, value: { type: 'bounds', minInclusive: value } };
    case 'atMost': return { ...typed, value: { type: 'bounds', maxInclusive: value } };
    default: return { ...typed, value };
  }
}

/** One IDS specification in the `ids.specifications` proposal shape. */
function idsSpecification(requirement: ExtractedRequirement, source: SourceRevision): Record<string, unknown> {
  const target = propertyTarget(requirement.property ?? '')!;
  const constraint = idsValue(requirement);
  // An attribute facet has no dataType or unit; classification already refused a unit on one.
  const facet = target.kind === 'attribute'
    ? { type: 'attribute', name: target.name, ...(constraint.value === undefined ? {} : { value: constraint.value }) }
    : { type: 'property', propertySet: target.set, baseName: target.name, ...constraint };
  return { name: specName(requirement), identifier: clip(`source-${requirement.id}`, 100), description: requirement.statement,
    instructions: provenanceNote(requirement, source), applicability: [{ type: 'entity', name: requirement.appliesTo!.ifcClass }], requirements: [facet] };
}

const chips = (rules: unknown[]) => ({ groups: [{ combinator: 'AND', rules }], authoredAs: 'chips' });
const NUMERIC = { equals: 'eq', notEquals: 'ne', atLeast: 'gte', atMost: 'lte' } as const;

/** One information rule over a `Qto_*` quantity, compared in SI like the native validation reading. */
function geometryRule(requirement: ExtractedRequirement, source: SourceRevision): Record<string, unknown> {
  const target = propertyTarget(requirement.property ?? '');
  const measure = measureUnit(requirement.unit ?? '');
  if (target?.kind !== 'property' || !measure || typeof requirement.value !== 'number') throw new Error('not a quantity comparison');
  const factor = unitFactor(measure.unit, measure.dataType, requirement.id)!;
  return { id: `source-${requirement.id}`, name: specName(requirement), severity: 'error',
    description: `${requirement.statement}\n${provenanceNote(requirement, source)}`,
    applicability: chips([{ kind: 'ifcType', values: [requirement.appliesTo!.ifcClass], op: 'in' }]),
    requirement: { kind: 'element', block: chips([{ kind: 'quantity', setName: target.set, quantityName: target.name,
      op: NUMERIC[requirement.operator as keyof typeof NUMERIC], value: Number((requirement.value * factor).toPrecision(12)), valueUnit: 'si' }]) } };
}

const idsAnswer = (title: string, specifications: unknown[]) =>
  JSON.stringify({ version: 1, kind: 'ids.specifications', title, ifcVersions: ['IFC4'], specifications });
const rulesAnswer = (title: string, rules: unknown[]) =>
  JSON.stringify({ version: 1, kind: 'rules.proposal', title, ruleSet: { version: 1, name: title, rules } });

/**
 * Classify every reviewed requirement and let the native parser of its target
 * refuse it individually, so one malformed requirement never blocks the rest.
 */
export function qualifyRequirements(review: RequirementReview, passages: readonly Passage[], sources: readonly SourceText[]): ClassifiedRequirement[] {
  return review.requirements.map(({ requirement, check }) => {
    const classified = classifyRequirement(requirement, check, sourceRevisionOf(requirement.span.source, passages, sources));
    if ((classified.target !== 'ids' && classified.target !== 'geometry') || !classified.source) return classified;
    try {
      if (classified.target === 'ids') parseIdsProposal(idsAnswer('Check', [idsSpecification(requirement, classified.source)]));
      else parseRulesProposal(rulesAnswer('Check', [geometryRule(requirement, classified.source)]));
      return classified;
    } catch (error) {
      return { requirement, check, target: 'unresolved', reason: 'native', detail: message(error) };
    }
  });
}

export interface NativeDrafts {
  ids: IdsProposal | null;
  rules: RulesProposal | null;
  document: DocumentOutline | null;
  /** A whole target the native parser refused (e.g. over its size limit); the other targets are unaffected. */
  refused: Array<{ target: 'ids' | 'geometry' | 'manual'; detail: string }>;
}

function documentItem(row: ClassifiedRequirement): { text: string; reason: string } {
  const { requirement } = row;
  const text = clip(`${requirement.id}: ${requirement.statement}${row.source ? `\n${provenanceNote(requirement, row.source)}` : ''}`, 2000);
  if (row.target === 'manual') return { text, reason: 'Manual requirement: check it by inspection; no automatic result is recorded' };
  return { text, reason: clip(`Unresolved: ${UNRESOLVED_NOTE[row.reason ?? 'native']}${row.detail ? ` (${row.detail})` : ''}`, 500) };
}

/**
 * The drafts for the included requirements. Excluded requirements stay in
 * the semantic review only; manual and unresolved ones are listed in the
 * document as "not checked" items with their provenance, never with a
 * pass/fail result.
 */
export function prepareNativeDrafts(proposal: SemanticRequirementProposal, classified: readonly ClassifiedRequirement[], excluded: ReadonlySet<string>): NativeDrafts {
  const included = classified.filter(row => !excluded.has(row.requirement.id));
  const refused: NativeDrafts['refused'] = [];
  const attempt = <T>(target: NativeDrafts['refused'][number]['target'], build: () => T): T | null => {
    try { return build(); }
    catch (error) { refused.push({ target, detail: message(error) }); return null; }
  };
  const idsRows = included.filter(row => row.target === 'ids' && row.source);
  const ruleRows = included.filter(row => row.target === 'geometry' && row.source);
  const documentRows = included.filter(row => row.target === 'manual' || row.target === 'unresolved');
  const ids = idsRows.length ? attempt('ids', () => parseIdsProposal(idsAnswer(proposal.title, idsRows.map(row => idsSpecification(row.requirement, row.source!))))) : null;
  const rules = ruleRows.length ? attempt('geometry', () => parseRulesProposal(rulesAnswer(proposal.title, ruleRows.map(row => geometryRule(row.requirement, row.source!))))) : null;
  const unsupported = [...documentRows.map(documentItem),
    ...proposal.unsupported.map(item => ({ text: item.text, reason: clip(`Not extracted as a requirement: ${item.reason}`, 500) }))];
  const document = unsupported.length ? attempt('manual', () => parseDocumentOutline(JSON.stringify({ version: 1, kind: 'document.outline', title: proposal.title,
    sections: [{ heading: 'Manual review', purpose: 'actions', blocks: [{ kind: 'text', style: 'body',
      text: 'These requirements from the attached source have no automatic check. Each is listed with its exact source passage; check it by inspection. This document records no pass or fail result for them.' }] }],
    unsupported }))) : null;
  return { ids, rules, document, refused };
}
