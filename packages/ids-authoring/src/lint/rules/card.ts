/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Cardinality rules IDSL-CARD-001 … 004. */

import type { IDSFacet, IDSSpecification } from '@ifc-lite/ids';
import type { FacetFieldName } from '../../document/fields.js';
import { quickFix, type OpBody } from '../fix.js';
import type { Finding, SpecRule } from '../types.js';
import { where } from '../walk.js';
import { gated } from './util.js';

export function isProhibitedSpec(spec: IDSSpecification): boolean {
  return spec.maxOccurs === 0;
}

export function isRequiredSpec(spec: IDSSpecification): boolean {
  return (spec.minOccurs ?? 0) >= 1 && spec.maxOccurs !== 0;
}

/** The value-like fields of a facet that a prohibited requirement would qualify. */
function qualifiers(facet: IDSFacet): FacetFieldName[] {
  switch (facet.type) {
    case 'property':
      return [...(facet.value ? (['property.value'] as const) : []), ...(facet.dataType ? (['property.dataType'] as const) : [])];
    case 'attribute':
      return facet.value ? ['attribute.value'] : [];
    case 'classification':
      return facet.value ? ['classification.value'] : [];
    case 'material':
      return facet.value ? ['material.value'] : [];
    default:
      return [];
  }
}

export const CARD_001: SpecRule = {
  code: 'IDSL-CARD-001',
  area: 'CARD',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Prohibited requirement with a value or data type',
  rationale:
    'A prohibited facet with a value can be read two ways: "must not have this property at all" or "must not have it with this value". Tools disagree (IDS issues #206 and #420), so the same file passes in one checker and fails in another. Without a value the meaning is unambiguous.',
  fix: 'Drop the value and data type, so the requirement reads "must not have it at all". The other reading cannot be expressed unambiguously in IDS 1.0.',
  references: ['https://github.com/buildingSMART/IDS/issues/206', 'https://github.com/buildingSMART/IDS/issues/420'],
  example: '<property cardinality="prohibited">…<value><simpleValue>EI30</simpleValue></value></property>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const r of spec.requirements) {
      if (r.requirement?.optionality !== 'prohibited') continue;
      const fields = qualifiers(r.facet);
      if (!fields.length) continue;
      const fix = quickFix('Prohibit it entirely (drop the value)', this.code, r.facetId, 'drop', fields.map((field): OpBody => ({ kind: 'facet.setField', payload: { facetId: r.facetId, field, value: null } })));
      out.push({ nodeId: r.facetId, message: `${where(r)} is prohibited with a ${fields.map((f) => f.slice(f.indexOf('.') + 1)).join(' and ')}: "must not have it" or "must not have this value"?`, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};

/** An optional requirement checks something only through a value, dataType or system. */
function checksNothingWhenOptional(facet: IDSFacet): boolean {
  switch (facet.type) {
    case 'property':
      return !facet.value && !facet.dataType;
    case 'attribute':
    case 'material':
      return !facet.value;
    case 'classification':
      return !facet.value && !facet.system;
    default:
      return false;
  }
}

export const CARD_002: SpecRule = {
  code: 'IDSL-CARD-002',
  area: 'CARD',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'info',
  title: 'Optional requirement that checks nothing',
  rationale:
    'An optional requirement means "if present, it must comply". Without a value (or data type, or classification system) there is nothing to comply with, so it can never fail.',
  fix: 'Make it required, or remove it.',
  example: '<property cardinality="optional"><propertySet>…</propertySet><baseName>…</baseName></property>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const r of spec.requirements) {
      if (r.requirement?.optionality !== 'optional' || !checksNothingWhenOptional(r.facet)) continue;
      const required = quickFix('Make it required', this.code, r.facetId, 'required', [{ kind: 'requirement.setOptionality', payload: { facetId: r.facetId, optionality: 'required' } }]);
      const remove = quickFix('Remove it', this.code, r.facetId, 'remove', [{ kind: 'facet.remove', payload: { facetId: r.facetId } }]);
      out.push({ nodeId: r.facetId, message: `${where(r)} is optional and has no value, so it can never fail`, fixes: gated(doc, ctx, [required, remove]) });
    }
    return out;
  },
};

export const CARD_003: SpecRule = {
  code: 'IDSL-CARD-003',
  area: 'CARD',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Prohibited specification with requirements',
  rationale:
    'A prohibited specification (maxOccurs 0) says "no element may match the applicability". Its requirements are never evaluated, so they suggest a check that does not happen. buildingSMART marks this combination as invalid (corpus case ids/invalid-prohibited_specifications_invalid_if_requirements_are_specified).',
  fix: 'Remove the requirements, or make the specification required.',
  example: '<specification …><applicability minOccurs="0" maxOccurs="0">…</applicability><requirements>…</requirements></specification>',
  check(spec, { ctx, doc }) {
    if (!isProhibitedSpec(spec.spec) || !spec.requirements.length) return [];
    const remove = quickFix('Remove the requirements', this.code, spec.specId, 'remove', spec.requirements.map((r): OpBody => ({ kind: 'facet.remove', payload: { facetId: r.facetId } })));
    const required = quickFix('Make the specification required', this.code, spec.specId, 'required', [{ kind: 'spec.setCardinality', payload: { specId: spec.specId, cardinality: 'required' } }]);
    return [{ nodeId: spec.specId, message: `the specification is prohibited, so its ${spec.requirements.length} requirement(s) are never checked`, fixes: gated(doc, ctx, [remove, required]) }];
  },
};

function hasValueSelection(facet: IDSFacet): boolean {
  switch (facet.type) {
    case 'property':
    case 'attribute':
    case 'classification':
    case 'material':
      return !!facet.value;
    case 'partOf':
      return true;
    default:
      return false;
  }
}

export const CARD_004: SpecRule = {
  code: 'IDSL-CARD-004',
  area: 'CARD',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'info',
  title: 'Required specification with a narrow applicability',
  rationale:
    'A required specification fails any model with no applicable element. When the applicability is narrowed by a value (a property or attribute value, a classification, a material, a containment), a model that legitimately has no such element fails the whole specification. Optional is usually what is meant.',
  fix: 'Make the specification optional.',
  example: '<applicability minOccurs="1">…<property>…<value><simpleValue>EI60</simpleValue></value></property></applicability>',
  check(spec, { ctx, doc }) {
    if (!isRequiredSpec(spec.spec)) return [];
    const narrow = spec.applicability.find((f) => hasValueSelection(f.facet));
    if (!narrow) return [];
    const fix = quickFix('Make it optional', this.code, spec.specId, 'optional', [{ kind: 'spec.setCardinality', payload: { specId: spec.specId, cardinality: 'optional' } }]);
    return [{ nodeId: spec.specId, message: `required specification narrowed by ${where(narrow)} (${narrow.facet.type}); models without such elements fail it`, fixes: gated(doc, ctx, [fix]) }];
  },
};
