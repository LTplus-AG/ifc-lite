/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Cross-specification rules: IDSL-SPEC-005, 006, 009. */

import type { IDSFacet, IDSSpecification } from '@ifc-lite/ids';
import { overlaps } from '../solver/solver.js';
import { quickFix } from '../fix.js';
import type { DocumentRule, Finding, SpecView } from '../types.js';
import { where } from '../walk.js';
import { subjectOf } from './spec.js';
import { gated } from './util.js';

/** Key-sorted JSON, so equal content gives equal text regardless of key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const SIGNATURES = new WeakMap<IDSSpecification, { applicability: string; full: string }>();

/** Order-insensitive content signatures of a spec, cached per spec object. */
function signatures(spec: IDSSpecification): { applicability: string; full: string } {
  let s = SIGNATURES.get(spec);
  if (!s) {
    const facets = (list: IDSFacet[]) => list.map(canonical).sort();
    const applicability = canonical({ versions: [...spec.ifcVersions].sort(), facets: facets(spec.applicability.facets) });
    const requirements = spec.requirements.map((r) => canonical({ facet: r.facet, optionality: r.optionality })).sort();
    s = { applicability, full: canonical({ applicability, requirements, min: spec.minOccurs ?? 0, max: spec.maxOccurs ?? 'unbounded' }) };
    SIGNATURES.set(spec, s);
  }
  return s;
}

export const SPEC_005: DocumentRule = {
  code: 'IDSL-SPEC-005',
  area: 'SPEC',
  scope: 'document',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Duplicate specification',
  rationale:
    'Two specifications have the same IFC versions, applicability, requirements and cardinality (names and descriptions aside). Every element is checked twice and reported twice, and an edit to one copy silently diverges from the other.',
  fix: 'Remove the later copy.',
  example: 'Two <specification> elements with identical content and different names.',
  check(specs, { ctx, doc }) {
    const seen = new Map<string, SpecView>();
    const out: Finding[] = [];
    for (const s of specs) {
      const key = signatures(s.spec).full;
      const first = seen.get(key);
      if (!first) {
        seen.set(key, s);
        continue;
      }
      const fix = quickFix(`Remove "${s.spec.name}"`, this.code, s.specId, 'remove', [{ kind: 'spec.remove', payload: { specId: s.specId } }]);
      out.push({ nodeId: s.specId, message: `"${s.spec.name}" duplicates "${first.spec.name}" (specification ${first.index + 1})`, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};

export const SPEC_006: DocumentRule = {
  code: 'IDSL-SPEC-006',
  area: 'SPEC',
  scope: 'document',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Overlapping specifications with conflicting requirements',
  rationale:
    'Two specifications select exactly the same elements (identical applicability and IFC versions) but require values with nothing in common for the same attribute or property. No element can pass both. This rule only compares identical applicabilities; partially overlapping ones need a model to decide (SPEC-004, model-aware).',
  example: 'Spec A: IfcDoor, FireRating = EI30. Spec B: IfcDoor, FireRating = EI60.',
  check(specs) {
    const out: Finding[] = [];
    specs.forEach((b, j) => {
      for (const a of specs.slice(0, j)) {
        if (signatures(a.spec).applicability !== signatures(b.spec).applicability) continue;
        const clash = conflict(a, b);
        if (clash) {
          out.push({ nodeId: clash.facetId, message: `${where(clash)} of "${b.spec.name}" conflicts with "${a.spec.name}", which selects the same elements` });
          return;
        }
      }
    });
    return out;
  },
};

function conflict(a: SpecView, b: SpecView) {
  const required = (s: SpecView) => s.requirements.filter((r) => r.requirement?.optionality === 'required');
  for (const rb of required(b)) {
    const sb = subjectOf(rb.facet);
    if (!sb?.constraint) continue;
    for (const ra of required(a)) {
      const sa = subjectOf(ra.facet);
      if (!sa?.constraint || sa.key !== sb.key || (sa.dataType && sb.dataType && sa.dataType !== sb.dataType)) continue;
      if (overlaps(sa.constraint, sb.constraint, sb.opts) === 'no') return rb;
    }
  }
  return undefined;
}

export const SPEC_009: DocumentRule = {
  code: 'IDSL-SPEC-009',
  area: 'SPEC',
  scope: 'document',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Duplicate identifier',
  rationale:
    'Specification identifiers are how reports, BCF issues and contracts refer to a requirement. Two specifications sharing one identifier make those references ambiguous.',
  fix: 'Give the later specification a unique identifier.',
  example: '<specification identifier="FS-01" …/> twice',
  check(specs, { ctx, doc }) {
    const used = new Set(specs.map((s) => s.spec.identifier?.trim()).filter((x): x is string => !!x));
    const seen = new Map<string, SpecView>();
    const out: Finding[] = [];
    for (const s of specs) {
      const id = s.spec.identifier?.trim();
      if (!id) continue;
      const first = seen.get(id);
      if (!first) {
        seen.set(id, s);
        continue;
      }
      let n = 2;
      while (used.has(`${id}-${n}`)) n++;
      used.add(`${id}-${n}`);
      const fix = quickFix(`Renumber to ${id}-${n}`, this.code, s.specId, `${id}-${n}`, [{ kind: 'spec.set', payload: { specId: s.specId, field: 'identifier', value: `${id}-${n}` } }]);
      out.push({ nodeId: s.specId, message: `identifier "${id}" is also used by "${first.spec.name}"`, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};
