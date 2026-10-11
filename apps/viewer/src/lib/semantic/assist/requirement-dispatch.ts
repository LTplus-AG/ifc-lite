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

import type { IFCVersion } from '@ifc-lite/ids';
import { parseIdsProposal, type IdsProposal } from '@/lib/check-authoring/ids-proposal';
import { parseRulesProposal, type RulesProposal } from '@/lib/check-authoring/rules-proposal';
import { parseDocumentOutline, type DocumentOutline } from '@/lib/check-authoring/document-outline';
import { unitFactor } from '@/lib/check-authoring/ids-constraint';
import type { ExtractedRequirement, SemanticRequirementProposal } from './requirement-proposal';
import type { SourceSpan } from './proposal-common';
import type { RequirementReview } from './requirement-review';
import type { SourceText } from './source-texts';
import type { Passage } from './spans';
import { classifyRequirement, propertyTarget, sourceRevisionOf, type ClassifiedRequirement, type SchemaMeasures, type SourceRevision,
  type UnresolvedReason } from './requirement-targets';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const clip = (text: string, max: number) => text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const passageNote = (span: SourceSpan, source: SourceRevision) =>
  `${source.source} "${source.title}" (revision ${source.revision}, ${source.characters} characters), characters ${span.start}-${span.end}: "${span.quote}"`;

/** Stored with the native record, in English like the other P07 record notes. */
export function provenanceNote(requirement: ExtractedRequirement, source: SourceRevision): string {
  return `Source requirement ${requirement.id} from ${passageNote(requirement.span, source)}${requirement.unit ? `. Stated unit: ${requirement.unit}` : ''}.`;
}

/** Where an item without a verified source claims to come from, labelled as unverified. */
const citedNote = (span: SourceSpan) =>
  `Cited from ${span.source}, characters ${span.start}-${span.end}: "${span.quote}" (not verified against the attached text).`;

const UNRESOLVED_NOTE: Record<UnresolvedReason, string> = {
  span: 'its source quote does not match the attached text',
  'source-missing': 'its source text is no longer attached',
  'source-changed': 'its source text changed after the assistant read it',
  unknown: 'the IFC schema defines no such standard property or quantity',
  scope: 'it applies to a linked-data class, which a check on the whole IFC class would widen',
  property: 'the property is not named as PropertySet.Property or an IFC attribute',
  operator: 'no native check expresses this comparison',
  value: 'the value does not fit the comparison',
  unit: 'the stated unit cannot be converted natively',
  native: 'the native validator refused it',
};

const specName = (requirement: ExtractedRequirement) => clip(`${requirement.id}: ${requirement.statement}`, 200);

type Measure = ClassifiedRequirement['measure'];

function idsValue(requirement: ExtractedRequirement, measure: Measure): Record<string, unknown> {
  const { value } = requirement;
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
function idsSpecification({ requirement, measure }: ClassifiedRequirement, source: SourceRevision): Record<string, unknown> {
  const target = propertyTarget(requirement.property ?? '')!;
  const constraint = idsValue(requirement, measure);
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
function geometryRule({ requirement, measure }: ClassifiedRequirement, source: SourceRevision): Record<string, unknown> {
  const target = propertyTarget(requirement.property ?? '');
  if (target?.kind !== 'property' || !measure || typeof requirement.value !== 'number') throw new Error('not a quantity comparison');
  const factor = unitFactor(measure.unit, measure.dataType, requirement.id)!;
  return { id: `source-${requirement.id}`, name: specName(requirement), severity: 'error',
    description: `${requirement.statement}\n${provenanceNote(requirement, source)}`,
    applicability: chips([{ kind: 'ifcType', values: [requirement.appliesTo!.ifcClass], op: 'in' }]),
    requirement: { kind: 'element', block: chips([{ kind: 'quantity', setName: target.set, quantityName: target.name,
      op: NUMERIC[requirement.operator as keyof typeof NUMERIC], value: Number((requirement.value * factor).toPrecision(12)), valueUnit: 'si' }]) } };
}

const idsAnswer = (title: string, specifications: unknown[], ifcVersions: readonly IFCVersion[] = ['IFC4']) =>
  JSON.stringify({ version: 1, kind: 'ids.specifications', title, ifcVersions, specifications });
const rulesAnswer = (title: string, rules: unknown[]) =>
  JSON.stringify({ version: 1, kind: 'rules.proposal', title, ruleSet: { version: 1, name: title, rules } });

/**
 * Classify every reviewed requirement and let the native parser of its target
 * refuse it individually, so one malformed requirement never blocks the rest.
 */
export function qualifyRequirements(review: RequirementReview, passages: readonly Passage[], sources: readonly SourceText[], schema: SchemaMeasures): ClassifiedRequirement[] {
  return review.requirements.map(({ requirement, check }) => {
    const classified = classifyRequirement(requirement, check, sourceRevisionOf(requirement.span.source, passages, sources), schema);
    if ((classified.target !== 'ids' && classified.target !== 'geometry') || !classified.source) return classified;
    try {
      if (classified.target === 'ids') parseIdsProposal(idsAnswer('Check', [idsSpecification(classified, classified.source)]));
      else parseRulesProposal(rulesAnswer('Check', [geometryRule(classified, classified.source)]));
      return classified;
    } catch (error) {
      return { requirement, check, target: 'unresolved', reason: 'native', detail: message(error), source: classified.source };
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
  const origin = row.source ? provenanceNote(requirement, row.source) : citedNote(requirement.span);
  const text = clip(`${requirement.id}: ${requirement.statement}\n${origin}`, 2000);
  if (row.target === 'manual') return { text, reason: 'Manual requirement: check it by inspection; no automatic result is recorded' };
  return { text, reason: clip(`Unresolved: ${UNRESOLVED_NOTE[row.reason ?? 'native']}${row.detail ? ` (${row.detail})` : ''}`, 500) };
}

/** A statement P16 could not extract, with its source passage when it cited one (verified, or labelled unverified). */
function unsupportedItem({ item, check }: RequirementReview['unsupported'][number], passages: readonly Passage[], sources: readonly SourceText[]): { text: string; reason: string } {
  const reason = clip(`Not extracted as a requirement: ${item.reason}`, 500);
  if (!item.span) return { text: clip(item.text, 2000), reason };
  const source = check?.status === 'verified' ? sourceRevisionOf(item.span.source, passages, sources) : null;
  const origin = source && typeof source !== 'string' ? `Source passage from ${passageNote(item.span, source)}.` : citedNote(item.span);
  return { text: clip(`${item.text}\n${origin}`, 2000), reason };
}

/** What the drafts are prepared against: the review's unsupported items, the attached texts and the IDS versions of the loaded models. */
export interface DraftContext {
  unsupported: RequirementReview['unsupported'];
  passages: readonly Passage[];
  sources: readonly SourceText[];
  /** Empty when models are loaded but none has an IDS version (IFC5): the IDS draft is then refused, never retargeted. */
  ifcVersions: readonly IFCVersion[];
}

/**
 * The drafts for the included requirements. Excluded requirements stay in
 * the semantic review only; manual and unresolved ones are listed in the
 * document as "not checked" items with their provenance, never with a
 * pass/fail result.
 */
export function prepareNativeDrafts(proposal: SemanticRequirementProposal, classified: readonly ClassifiedRequirement[], excluded: ReadonlySet<string>,
  context: DraftContext): NativeDrafts {
  const { ifcVersions } = context;
  const included = classified.filter(row => !excluded.has(row.requirement.id));
  const refused: NativeDrafts['refused'] = [];
  const attempt = <T>(target: NativeDrafts['refused'][number]['target'], build: () => T): T | null => {
    try { return build(); }
    catch (error) { refused.push({ target, detail: message(error) }); return null; }
  };
  const idsRows = included.filter(row => row.target === 'ids' && row.source);
  const ruleRows = included.filter(row => row.target === 'geometry' && row.source);
  const documentRows = included.filter(row => row.target === 'manual' || row.target === 'unresolved');
  const ids = idsRows.length ? attempt('ids', () => {
    if (!ifcVersions.length) throw new Error('none of the loaded models has an IFC version IDS can check (IFC2X3, IFC4 or IFC4X3)');
    return parseIdsProposal(idsAnswer(proposal.title, idsRows.map(row => idsSpecification(row, row.source!)), ifcVersions));
  }) : null;
  const rules = ruleRows.length ? attempt('geometry', () => parseRulesProposal(rulesAnswer(proposal.title, ruleRows.map(row => geometryRule(row, row.source!))))) : null;
  const unsupported = [...documentRows.map(documentItem),
    ...context.unsupported.map(row => unsupportedItem(row, context.passages, context.sources))];
  const document = unsupported.length ? attempt('manual', () => parseDocumentOutline(JSON.stringify({ version: 1, kind: 'document.outline', title: proposal.title,
    sections: [{ heading: 'Manual review', purpose: 'actions', blocks: [{ kind: 'text', style: 'body',
      text: 'These requirements from the attached source have no automatic check. Each is listed with the source passage it cites, marked as unverified where it does not match the attached text; check it by inspection. This document records no pass or fail result for them.' }] }],
    unsupported }))) : null;
  return { ids, rules, document, refused };
}
