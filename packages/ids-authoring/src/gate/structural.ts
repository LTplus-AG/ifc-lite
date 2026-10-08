/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Structural rules (GATE-STR-00x) and op-level value rules that the
 * reducer itself does not enforce, plus the map from an applied op to the
 * facet fields whose grounding it may have changed.
 */

import type { IDSFacet, IDSRequirement } from '@ifc-lite/ids';
import { presentFields, type FacetFieldName } from '../document/fields.js';
import { facetAt, locateFacet, locateSpec } from '../document/node-index.js';
import type { StudioDocument } from '../document/types.js';
import type { PrimitiveOp } from '../ops/types.js';
import type { Uuid } from '../uuid.js';
import { isReservedPsetName } from './grounding-pset.js';
import type { GateCode } from './types.js';

export interface StructuralProblem {
  code: GateCode;
  message: string;
  /** Path below `ops[i]`, e.g. `.payload.value`. */
  at: string;
}

// IDS 1.0 XSD: author is `[^@]+@[^\.]+\..+`, date is xs:date.
const AUTHOR = /^[^@]+@[^.]+\..+$/;
const XS_DATE = /^-?\d{4,}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(Z|[+-]\d{2}:\d{2})?$/;

function versionsProblem(versions: readonly string[]): StructuralProblem[] {
  return new Set(versions).size === versions.length
    ? []
    : [{ code: 'GATE-STR-007', message: 'ifcVersions lists a version twice', at: '.payload' }];
}

/** Checks on the op payload itself, before it is applied. */
export function checkOpPayload(op: PrimitiveOp): StructuralProblem[] {
  switch (op.kind) {
    case 'doc.setInfo': {
      const { field, value } = op.payload;
      if (value === null) return [];
      if (field === 'title' && value.trim() === '') return [{ code: 'GATE-STR-007', message: 'title cannot be empty', at: '.payload.value' }];
      if (field === 'author' && !AUTHOR.test(value)) return [{ code: 'GATE-VAL-007', message: `author "${value}" is not an e-mail address`, at: '.payload.value' }];
      if (field === 'date' && !XS_DATE.test(value)) return [{ code: 'GATE-VAL-007', message: `date "${value}" is not an xs:date (YYYY-MM-DD)`, at: '.payload.value' }];
      return [];
    }
    case 'spec.add':
      return [
        ...(op.payload.name.trim() === '' ? [{ code: 'GATE-STR-007' as const, message: 'specification name cannot be empty', at: '.payload.name' }] : []),
        ...versionsProblem(op.payload.ifcVersions),
      ];
    case 'spec.set':
      return op.payload.field === 'name' && (op.payload.value ?? '').trim() === ''
        ? [{ code: 'GATE-STR-007', message: 'specification name cannot be empty', at: '.payload.value' }]
        : [];
    case 'spec.setIfcVersions':
      return versionsProblem(op.payload.versions);
    case 'spec.patch':
      if (op.payload.set.ifcVersions?.length === 0) return [{ code: 'GATE-STR-007', message: 'ifcVersions cannot be empty', at: '.payload.set.ifcVersions' }];
      return op.payload.set.ifcVersions ? versionsProblem(op.payload.set.ifcVersions) : [];
    case 'meta.custom.declarePset':
      return isReservedPsetName(op.payload.decl.name)
        ? [{ code: 'GATE-CUST-002', message: `custom property sets cannot use a reserved prefix (${op.payload.decl.name}); use a project prefix such as "Project_"`, at: '.payload.decl.name' }]
        : [];
    default:
      return [];
  }
}

/** Facet-level structural rules on the facet as it is AFTER the op. */
export function checkFacetStructure(facet: IDSFacet, requirement: IDSRequirement | undefined): StructuralProblem[] {
  const out: StructuralProblem[] = [];
  if (facet.type === 'partOf' && !facet.entity) {
    out.push({ code: 'GATE-STR-004', message: 'a partOf facet needs its related entity (IDS 1.0)', at: '.payload' });
  }
  if (facet.type === 'property' && facet.dataType && facet.dataType.type !== 'simpleValue') {
    out.push({ code: 'GATE-STR-005', message: 'a property dataType must be a single value', at: '.payload' });
  }
  if (facet.type === 'entity' && requirement && requirement.optionality !== 'required') {
    out.push({ code: 'GATE-STR-008', message: 'an entity requirement has no cardinality in IDS 1.0; it can only be required', at: '.payload' });
  }
  return out;
}

/** Which facet fields an applied op may have changed the grounding of. */
export interface GroundingTarget {
  facetId: Uuid;
  fields: FacetFieldName[];
  /** Path below `ops[i]` to point issues at. */
  at: (field: FacetFieldName) => string;
}

const DEPENDENTS: Partial<Record<FacetFieldName, FacetFieldName[]>> = {
  'entity.name': ['entity.predefinedType'],
  'partOf.entity.name': ['partOf.entity.predefinedType'],
  'property.propertySet': ['property.baseName', 'property.dataType', 'property.value'],
  'property.baseName': ['property.dataType', 'property.value'],
};

function draftPath(field: FacetFieldName): string {
  return `.payload.facet.${field.slice(field.indexOf('.') + 1)}`;
}

function allFacetsOf(doc: StudioDocument, specId: Uuid): GroundingTarget[] {
  const i = locateSpec(doc, specId);
  if (i === undefined) return [];
  const spec = doc.ids.specifications[i];
  const nodes = doc.nodes.specs[i];
  const facets: [Uuid, IDSFacet][] = [
    ...spec.applicability.facets.map((f, j): [Uuid, IDSFacet] => [nodes.applicability[j].id, f]),
    ...spec.requirements.map((r): [Uuid, IDSFacet] => [r.id, r.facet]),
  ];
  return facets.map(([facetId, facet]) => ({ facetId, fields: presentFields(facet), at: () => '' }));
}

export function groundingTargets(op: PrimitiveOp, after: StudioDocument, beforeSpecOf: (facetId: Uuid) => Uuid | undefined): GroundingTarget[] {
  switch (op.kind) {
    case 'facet.add':
    case 'facet.replace': {
      const loc = locateFacet(after, op.payload.facetId);
      return loc ? [{ facetId: op.payload.facetId, fields: presentFields(facetAt(after, loc)), at: draftPath }] : [];
    }
    case 'facet.restore':
      return [{ facetId: op.payload.nodes.id, fields: presentFields(op.payload.facet), at: () => '.payload.facet' }];
    case 'facet.move': {
      const loc = locateFacet(after, op.payload.facetId);
      if (!loc || beforeSpecOf(op.payload.facetId) === loc.specId) return [];
      return [{ facetId: op.payload.facetId, fields: presentFields(facetAt(after, loc)), at: () => '' }];
    }
    case 'facet.setField':
    case 'value.set':
    case 'value.addEnumValue':
    case 'value.removeEnumValue': {
      const { facetId, field } = op.payload;
      return [{ facetId, fields: [field, ...(DEPENDENTS[field] ?? [])], at: (f) => (f === field ? '.payload.value' : '') }];
    }
    case 'spec.setIfcVersions':
    case 'spec.restore':
      return allFacetsOf(after, op.kind === 'spec.restore' ? op.payload.spec.id : op.payload.specId);
    case 'spec.patch':
      return op.payload.set.ifcVersions ? allFacetsOf(after, op.payload.specId) : [];
    default:
      return [];
  }
}

/** Facets whose structure (not grounding) an op may have changed. */
export function structureTargets(op: PrimitiveOp): Uuid[] {
  switch (op.kind) {
    case 'facet.add':
    case 'facet.replace':
    case 'facet.move':
    case 'facet.setField':
    case 'value.set':
    case 'facet.patch':
    case 'requirement.setOptionality':
      return [op.payload.facetId];
    case 'facet.restore':
      return [op.payload.nodes.id];
    default:
      return [];
  }
}
