/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Field-level comparison of matched nodes, for the diff. */

import type { IDSDocument, IDSRequirement, IDSSpecification } from '@ifc-lite/ids';
import { FACET_FIELDS, getField, type FacetFieldName } from '../document/fields.js';
import type { CustomPsetDecl, StudioDocument, UserDefinedTypeDecl } from '../document/types.js';
import { canonical } from '../match/cascade.js';
import type { InfoField, RequirementSnapshot, SpecCardinality } from '../ops/types.js';
import type { FacetSite } from './align.js';
import type { DiffEntry, FacetContext, RequirementField, SpecField } from './types.js';

const INFO_FIELDS: readonly InfoField[] = ['title', 'copyright', 'version', 'description', 'author', 'date', 'purpose', 'milestone'];

export const SPEC_FIELDS: readonly SpecField[] = [
  'name',
  'description',
  'instructions',
  'identifier',
  'ifcVersions',
  'ifcVersionRaw',
  'minOccurs',
  'maxOccurs',
  'applicabilityCardinality',
];

const REQUIREMENT_FIELDS: readonly RequirementField[] = ['optionality', 'cardinalityRaw', 'description', 'instructions'];

export function same(x: unknown, y: unknown): boolean {
  return canonical(x) === canonical(y);
}

export function infoEntries(a: IDSDocument, b: IDSDocument): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const field of INFO_FIELDS) {
    const old = a.info[field];
    const next = b.info[field];
    if (old === next) continue;
    out.push({ kind: 'info.changed', field, ...(old !== undefined ? { old } : {}), ...(next !== undefined ? { new: next } : {}) });
  }
  return out;
}

function udtKey(d: UserDefinedTypeDecl): string {
  return `${d.entity.toUpperCase()}\u0000${d.value.toUpperCase()}`;
}

export function customEntries(a: StudioDocument, b: StudioDocument): DiffEntry[] {
  const out: DiffEntry[] = [];
  const psetsA = new Map(a.meta.custom.psets.map((d) => [d.name, d]));
  const psetsB = new Map(b.meta.custom.psets.map((d) => [d.name, d]));
  const declared = (d: CustomPsetDecl): DiffEntry => ({ kind: 'custom.psetDeclared', decl: d });
  for (const [name, d] of psetsA) {
    const other = psetsB.get(name);
    if (!other || !same(d, other)) out.push({ kind: 'custom.psetRemoved', decl: d });
  }
  for (const [name, d] of psetsB) {
    const other = psetsA.get(name);
    if (!other || !same(d, other)) out.push(declared(d));
  }
  const udtA = new Map(a.meta.custom.userDefinedTypes.map((d) => [udtKey(d), d]));
  const udtB = new Map(b.meta.custom.userDefinedTypes.map((d) => [udtKey(d), d]));
  for (const [k, d] of udtA) if (!udtB.has(k)) out.push({ kind: 'custom.userDefinedTypeRemoved', decl: d });
  for (const [k, d] of udtB) if (!udtA.has(k)) out.push({ kind: 'custom.userDefinedTypeDeclared', decl: d });
  return out;
}

export function specField(spec: IDSSpecification, field: SpecField): unknown {
  return field === 'applicabilityCardinality' ? spec.applicability.cardinality : spec[field];
}

/** required / optional / prohibited, as IDS reads minOccurs and maxOccurs. */
export function specCardinality(spec: IDSSpecification): SpecCardinality {
  if (spec.maxOccurs === 0) return 'prohibited';
  return (spec.minOccurs ?? 0) >= 1 ? 'required' : 'optional';
}

export function specEntries(a: IDSSpecification, b: IDSSpecification): DiffEntry[] {
  const out: DiffEntry[] = [];
  const cardinality = { old: specCardinality(a), new: specCardinality(b) };
  for (const field of SPEC_FIELDS) {
    const old = specField(a, field);
    const next = specField(b, field);
    if (same(old, next)) continue;
    const occurs = field === 'minOccurs' || field === 'maxOccurs';
    out.push({ kind: 'spec.changed', specId: a.id, specName: b.name, field, old, new: next, ...(occurs ? { cardinality } : {}) });
  }
  return out;
}

/** The requirement record of a site in its document, if it is a requirement. */
export function requirementOf(doc: StudioDocument, site: FacetSite): IDSRequirement | undefined {
  return site.section === 'requirements' ? doc.ids.specifications[site.specIndex].requirements[site.index] : undefined;
}

export function snapshot(r: IDSRequirement | undefined): RequirementSnapshot | undefined {
  if (!r) return undefined;
  const snap: RequirementSnapshot = { optionality: r.optionality };
  if (r.cardinalityRaw !== undefined) snap.cardinalityRaw = r.cardinalityRaw;
  if (r.description !== undefined) snap.description = r.description;
  if (r.instructions !== undefined) snap.instructions = r.instructions;
  return snap;
}

/**
 * Entries for one matched facet pair. `ctx` is the shared facet context
 * (named by the id in `a`). A requirement that arrives from applicability
 * starts as `required` with no texts (what `facet.move` creates), so only
 * the differences from that are reported.
 */
export function facetEntries(
  ctx: FacetContext,
  aSite: FacetSite,
  bSite: FacetSite,
  reqA: IDSRequirement | undefined,
  reqB: IDSRequirement | undefined,
): DiffEntry[] {
  const out: DiffEntry[] = [];
  if (aSite.facet.type !== bSite.facet.type) {
    const requirement = snapshot(reqB);
    out.push({ ...ctx, kind: 'facet.replaced', old: aSite.facet, nodes: bSite.nodes, ...(requirement ? { requirement } : {}) });
    return out;
  }
  for (const field of FACET_FIELDS[aSite.facet.type] as readonly FacetFieldName[]) {
    const old = getField(aSite.facet, field);
    const next = getField(bSite.facet, field);
    if (same(old, next)) continue;
    const constraintId = bSite.nodes.constraints[field];
    out.push({
      ...ctx,
      kind: 'facet.valueChanged',
      field,
      ...(old ? { old } : {}),
      ...(next ? { new: next } : {}),
      ...(constraintId ? { constraintId } : {}),
    });
  }
  if (aSite.facet.type === 'partOf' && bSite.facet.type === 'partOf') {
    const o = { relation: aSite.facet.relation, ...(aSite.facet.rawRelation !== undefined ? { rawRelation: aSite.facet.rawRelation } : {}) };
    const n = { relation: bSite.facet.relation, ...(bSite.facet.rawRelation !== undefined ? { rawRelation: bSite.facet.rawRelation } : {}) };
    if (!same(o, n)) out.push({ ...ctx, kind: 'facet.relationChanged', old: o, new: n });
  }
  if (reqB) {
    const base = reqA ?? { optionality: 'required' };
    for (const field of REQUIREMENT_FIELDS) {
      const old = (base as Partial<IDSRequirement>)[field];
      const next = reqB[field];
      if (same(old, next)) continue;
      out.push({ ...ctx, kind: 'requirement.changed', field, old, new: next });
    }
  }
  return out;
}
