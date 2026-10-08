/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ids.specifications` (viewer AI P07, #6915): a bounded, typed IDS draft the
 * assistant may propose. The strict parser maps it onto the native
 * `IDSDocument`; `ids-draft.ts` serialises it through the native writer and
 * reads it back with the native parser, so what is reviewed, dry-run, saved
 * and exported is exactly what `parseIDS` sees. Nothing here runs or saves.
 */

import { auditIDSDocument, parseIDS, type IDSAuditIssue, type IDSDocument, type IDSRequirement, type IDSSpecification, type IFCVersion } from '@ifc-lite/ids';
import { writeIdsXml } from '@ifc-lite/rules';
import { isRecord, onlyKeys, optionalText, parseProposalEnvelope, parseUnsupported, requiredText, TEXT_LIMIT, unsupportedNote, type UnsupportedRequirement } from './proposal-json';
import { parseApplicability, parseFacet, parseOptionality } from './ids-facets';

export const IDS_SPECIFICATION_LIMIT = 50;
const VERSIONS: readonly IFCVersion[] = ['IFC2X3', 'IFC4', 'IFC4X3_ADD2'];
const SPEC_CARDINALITY = { required: { minOccurs: 1, maxOccurs: 'unbounded' }, optional: { minOccurs: 0, maxOccurs: 'unbounded' },
  prohibited: { minOccurs: 0, maxOccurs: 0 } } as const;
export type SpecificationCardinality = keyof typeof SPEC_CARDINALITY;

/** A measure value authored in a declared unit; `document` holds it in SI, as IDS stores it. */
export interface DeclaredUnit {
  spec: number;
  part: 'applicability' | 'requirements';
  /** Facet index within `part`, as written (applicability in `ids.xsd` order). */
  index: number;
  unit: string;
}

/** The authored, editable draft. `document` carries no unsupported notes; they are composed at serialisation. */
export interface IdsProposal {
  title: string;
  rationale?: string;
  document: IDSDocument;
  unsupported: UnsupportedRequirement[];
  /** Declared units, so the review shows each SI conversion instead of hiding it. */
  units: DeclaredUnit[];
}

function versions(value: unknown, at: string, fallback: IFCVersion[]): IFCVersion[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length === 0 || !value.every(v => VERSIONS.includes(v as IFCVersion))) {
    throw new Error(`${at} must list IFC versions from ${VERSIONS.join(', ')}`);
  }
  return [...new Set(value as IFCVersion[])];
}

function requirement(value: unknown, at: string, index: number, onUnit: (unit: string) => void): IDSRequirement {
  const facet = parseFacet(value, at, ['cardinality', 'instructions'], onUnit);
  const record = value as Record<string, unknown>;
  const instructions = optionalText(record, 'instructions', at, 1000);
  return { id: `req-${index}`, facet, optionality: parseOptionality(record.cardinality, facet, at), ...(instructions ? { instructions } : {}) };
}

function specification(value: unknown, index: number, fallback: IFCVersion[], units: DeclaredUnit[]): IDSSpecification {
  const at = `specifications[${index}]`;
  if (!isRecord(value)) throw new Error(`${at} must be an object`);
  onlyKeys(value, ['name', 'description', 'instructions', 'identifier', 'ifcVersions', 'cardinality', 'applicability', 'requirements'], at);
  const cardinality = value.cardinality === undefined ? 'required' : value.cardinality;
  if (typeof cardinality !== 'string' || !(cardinality in SPEC_CARDINALITY)) throw new Error(`${at}.cardinality must be required, optional or prohibited`);
  const occurs = SPEC_CARDINALITY[cardinality as SpecificationCardinality];
  if (!Array.isArray(value.requirements) || value.requirements.length > 30) throw new Error(`${at}.requirements must list at most 30 requirement facets`);
  if (value.requirements.length === 0 && cardinality !== 'prohibited') {
    throw new Error(`${at} has no requirements; add at least one, or use cardinality "prohibited" to forbid the applicable elements`);
  }
  const description = optionalText(value, 'description', at), instructions = optionalText(value, 'instructions', at, 1000);
  const identifier = optionalText(value, 'identifier', at, 100);
  return {
    id: identifier ?? `spec-${index}`, name: requiredText(value, 'name', at),
    ...(description ? { description } : {}), ...(instructions ? { instructions } : {}), ...(identifier ? { identifier } : {}),
    ifcVersions: versions(value.ifcVersions, `${at}.ifcVersions`, fallback),
    applicability: { facets: parseApplicability(value.applicability, `${at}.applicability`,
      (position, unit) => units.push({ spec: index, part: 'applicability', index: position, unit })) },
    requirements: value.requirements.map((item, i) => requirement(item, `${at}.requirements[${i}]`, i,
      unit => units.push({ spec: index, part: 'requirements', index: i, unit }))),
    minOccurs: occurs.minOccurs, maxOccurs: occurs.maxOccurs,
  };
}

/** Strict, bounded parse of a complete answer. Throws with a reason the assistant can act on. */
export function parseIdsProposal(answer: string): IdsProposal {
  const value = parseProposalEnvelope(answer, 'ids.specifications');
  onlyKeys(value, ['version', 'kind', 'title', 'description', 'rationale', 'ifcVersions', 'specifications', 'unsupported'], 'The proposal');
  const title = requiredText(value, 'title', 'The proposal');
  const description = optionalText(value, 'description', 'The proposal', TEXT_LIMIT);
  const rationale = optionalText(value, 'rationale', 'The proposal', TEXT_LIMIT);
  const fallback = versions(value.ifcVersions, 'ifcVersions', ['IFC4']);
  const unsupported = parseUnsupported(value.unsupported);
  if (!Array.isArray(value.specifications)) throw new Error('"specifications" must be a list');
  if (value.specifications.length === 0 && unsupported.length === 0) throw new Error('The proposal needs at least one specification, or lists every requirement as unsupported');
  if (value.specifications.length > IDS_SPECIFICATION_LIMIT) throw new Error(`At most ${IDS_SPECIFICATION_LIMIT} specifications may be proposed at once`);
  const units: DeclaredUnit[] = [];
  const specifications = value.specifications.map((spec, index) => specification(spec, index, fallback, units));
  const names = new Set<string>();
  for (const spec of specifications) {
    if (names.has(spec.name)) throw new Error(`Specification names must be distinct: "${spec.name}" repeats`);
    names.add(spec.name);
  }
  const ids = specifications.map(spec => spec.id);
  if (new Set(ids).size !== ids.length) throw new Error('Specification identifiers must be distinct');
  return { title, ...(rationale ? { rationale } : {}), unsupported, units,
    document: { info: { title, ...(description ? { description } : {}) }, specifications } };
}

export function specificationCardinality(spec: Pick<IDSSpecification, 'minOccurs' | 'maxOccurs'>): SpecificationCardinality {
  if (spec.maxOccurs === 0) return 'prohibited';
  return (spec.minOccurs ?? 0) > 0 ? 'required' : 'optional';
}

export function withSpecificationCardinality(spec: IDSSpecification, cardinality: SpecificationCardinality): IDSSpecification {
  return { ...spec, ...SPEC_CARDINALITY[cardinality] };
}

/** What is reviewed, dry-run, saved and exported: the native writer's XML, read back by the native parser. */
export interface IdsDraft {
  proposal: IdsProposal;
  xml: string;
  document: IDSDocument;
}

/**
 * Unsupported requirements travel inside the IDS itself: the document
 * description lists all of them, and a related specification's instructions
 * name its own, so a saved or exported file never silently loses them.
 */
export function buildIdsDraft(proposal: IdsProposal): IdsDraft {
  const note = unsupportedNote(proposal.unsupported);
  const info = { ...proposal.document.info,
    ...(note ? { description: [proposal.document.info.description, note].filter(Boolean).join('\n\n') } : {}) };
  const specifications = proposal.document.specifications.map(spec => {
    const own = proposal.unsupported.filter(item => item.relatesTo === spec.name);
    return own.length ? { ...spec, instructions: [spec.instructions, unsupportedNote(own)].filter(Boolean).join('\n') } : spec;
  });
  if (!specifications.length) return { proposal, xml: '', document: { info, specifications: [] } };
  const xml = writeIdsXml({ info, specifications });
  return { proposal, xml, document: parseIDS(xml) };
}

/** The exact XML each audit result describes, so a result cannot be reused for a different draft. */
const auditedXml = new WeakMap<readonly IDSAuditIssue[], string>();

/** Native document audit (XSD, IFC schema, restriction coherence). Errors block saving and export. */
export async function auditIdsDraft(draft: IdsDraft): Promise<IDSAuditIssue[]> {
  if (!draft.xml) return [];
  const issues = (await auditIDSDocument(draft.xml)).issues;
  auditedXml.set(issues, draft.xml);
  return issues;
}

/** Whether `issues` came from auditing exactly `xml`. */
export function isAuditOf(issues: readonly IDSAuditIssue[] | null, xml: string): boolean {
  return issues !== null && auditedXml.get(issues) === xml;
}
