/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Specification semantics: IDSL-SPEC-001, 002, 003, 007, 008. */

import type { IDSConstraint, IDSFacet } from '@ifc-lite/ids';
import { implies, overlaps, type SolveOptions } from '../solver/solver.js';
import { quickFix } from '../fix.js';
import type { FacetView, Finding, SpecRule } from '../types.js';
import { where } from '../walk.js';
import { isProhibitedSpec, isRequiredSpec } from './card.js';
import { gated, single } from './util.js';

/**
 * What a facet is ABOUT (its identity) and the constraint on it. Only
 * single-valued subjects get a key: an element has one class, one value per
 * attribute and one value per property. Classifications and materials can
 * be multiple, so two different values are not a contradiction there.
 */
export interface Subject {
  key: string;
  constraint?: IDSConstraint;
  /** Property data type (values are compared under it). */
  dataType?: string;
  opts: SolveOptions;
}

export function subjectOf(facet: IDSFacet): Subject | undefined {
  switch (facet.type) {
    case 'entity':
      return facet.predefinedType ? undefined : { key: 'entity', constraint: facet.name, opts: { caseInsensitive: true } };
    case 'attribute': {
      const name = single(facet.name);
      return name ? { key: `attribute|${name.toLowerCase()}`, constraint: facet.value, opts: {} } : undefined;
    }
    case 'property': {
      const pset = single(facet.propertySet);
      const name = single(facet.baseName);
      return pset && name ? { key: `property|${pset}|${name}`, constraint: facet.value, dataType: single(facet.dataType)?.toUpperCase(), opts: {} } : undefined;
    }
    default:
      return undefined;
  }
}

function comparable(a: Subject, b: Subject): boolean {
  return a.key === b.key && (a.dataType === undefined || b.dataType === undefined || a.dataType === b.dataType);
}

function binding(r: FacetView): boolean {
  return r.requirement?.optionality === 'required' || r.requirement?.optionality === 'optional';
}

export const SPEC_001: SpecRule = {
  code: 'IDSL-SPEC-001',
  area: 'SPEC',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Requirement that can never fail',
  rationale:
    'The requirement asks for something the applicability already guarantees: the same entity, attribute or property with the same or a weaker constraint. Every applicable element satisfies it by construction, so it checks nothing. Usually the facet belongs in only one of the two sections.',
  fix: 'Remove the requirement.',
  example: '<applicability>…<property>…<value><simpleValue>EI60</simpleValue></value></property></applicability><requirements><property>… (same property, no value)</property></requirements>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const r of spec.requirements) {
      if (r.requirement?.optionality !== 'required') continue;
      const rs = subjectOf(r.facet);
      if (!rs) continue;
      const implied = spec.applicability.find((a) => {
        const as = subjectOf(a.facet);
        if (!as || as.key !== rs.key || (rs.dataType && rs.dataType !== as.dataType)) return false;
        if (!rs.constraint) return true;
        return !!as.constraint && implies(as.constraint, rs.constraint, rs.opts) === 'yes';
      });
      if (!implied) continue;
      const fix = quickFix('Remove the requirement', this.code, r.facetId, 'remove', [{ kind: 'facet.remove', payload: { facetId: r.facetId } }]);
      out.push({ nodeId: r.facetId, message: `${where(r)} is already guaranteed by ${where(implied)}, so it can never fail`, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};

export const SPEC_002: SpecRule = {
  code: 'IDSL-SPEC-002',
  area: 'SPEC',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'error',
  title: 'Contradictory requirements',
  rationale:
    'Two constraints on the same single-valued subject (the entity class, one attribute, one property) have no value in common: two requirements with disjoint enumerations or bounds, or a requirement that excludes every value the applicability selects. No element can pass. The solver only reports a contradiction it can prove (finite sets and numeric ranges exactly; patterns are never declared disjoint).',
  example: '<requirements><property>…<value><simpleValue>EI60</simpleValue></value></property><property>… (same property) <value><simpleValue>EI90</simpleValue></value></property></requirements>',
  check(spec) {
    const out: Finding[] = [];
    const reqs = spec.requirements.filter(binding);
    reqs.forEach((r, i) => {
      const rs = subjectOf(r.facet);
      if (!rs?.constraint) return;
      for (const a of spec.applicability) {
        const as = subjectOf(a.facet);
        if (as?.constraint && comparable(as, rs) && overlaps(as.constraint, rs.constraint, rs.opts) === 'no') {
          out.push({ nodeId: r.facetId, message: `${where(r)} excludes every element that ${where(a)} selects; no applicable element can pass` });
          return;
        }
      }
      for (const other of reqs.slice(0, i)) {
        const os = subjectOf(other.facet);
        const eitherRequired = r.requirement?.optionality === 'required' || other.requirement?.optionality === 'required';
        if (os?.constraint && eitherRequired && comparable(os, rs) && overlaps(os.constraint, rs.constraint, rs.opts) === 'no') {
          out.push({ nodeId: r.facetId, message: `${where(r)} and ${where(other)} constrain the same ${rs.key.split('|')[0]} to values with nothing in common` });
          return;
        }
      }
    });
    return out;
  },
};

export const SPEC_003: SpecRule = {
  code: 'IDSL-SPEC-003',
  area: 'SPEC',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Applicability that can never match',
  rationale:
    'All applicability facets must hold at once. Two of them constrain the same single-valued subject (two different entity classes, two disjoint values of one property) so no element can match, and the specification never applies.',
  example: '<applicability><entity>IFCWALL</entity><entity>IFCSLAB</entity></applicability>',
  check(spec) {
    const out: Finding[] = [];
    spec.applicability.forEach((a, i) => {
      const as = subjectOf(a.facet);
      const ac = as?.constraint;
      if (!as || !ac) return;
      const clash = spec.applicability.slice(0, i).find((b) => {
        const bs = subjectOf(b.facet);
        return !!bs?.constraint && comparable(as, bs) && overlaps(bs.constraint, ac, as.opts) === 'no';
      });
      if (clash) out.push({ nodeId: a.facetId, message: `${where(a)} and ${where(clash)} cannot both hold; the specification never applies` });
    });
    return out;
  },
};

export const SPEC_007: SpecRule = {
  code: 'IDSL-SPEC-007',
  area: 'SPEC',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'info',
  title: 'Specification without requirements',
  rationale:
    'A specification with no requirements only checks whether applicable elements exist (when it is required), or checks nothing at all (when it is optional). That is sometimes intended, but often a requirement was forgotten. Prohibited specifications are exempt: "no element may match" needs no requirements.',
  example: '<specification …><applicability>…</applicability></specification>',
  check(spec) {
    if (spec.requirements.length || isProhibitedSpec(spec.spec)) return [];
    const message = isRequiredSpec(spec.spec)
      ? 'the specification has no requirements; it only checks that applicable elements exist'
      : 'the specification has no requirements and is optional, so it checks nothing';
    return [{ nodeId: spec.specId, message }];
  },
};

export const SPEC_008: SpecRule = {
  code: 'IDSL-SPEC-008',
  area: 'SPEC',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'info',
  title: 'Specification without description or instructions',
  rationale:
    'Modellers see the description and instructions when a check fails. Without them the failure report shows only facet text, which rarely tells a modeller what to change or why the requirement exists.',
  example: '<specification name="Doors" ifcVersion="IFC4"> (no description, no instructions)',
  check(spec) {
    if (spec.spec.description?.trim() || spec.spec.instructions?.trim()) return [];
    return [{ nodeId: spec.specId, message: `"${spec.spec.name}" has neither a description nor instructions for modellers` }];
  },
};
