/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Value rules IDSL-VAL-001 … 006. */

import type { IDSConstraint } from '@ifc-lite/ids';
import type { FacetFieldName } from '../../document/fields.js';
import { getField } from '../../document/fields.js';
import { rankCandidates } from '../../gate/rank.js';
import type { Uuid } from '../../uuid.js';
import { quickFix, type OpBody } from '../fix.js';
import type { Finding, SpecRule } from '../types.js';
import { allFacets, at } from '../walk.js';
import { gated, single, tables } from './util.js';
import { baseOf, FLOAT_XSD, mapLiterals, NUMERIC_XSD, siteLiterals, valueSites } from './value-sites.js';

export function rawSet(facetId: Uuid, field: FacetFieldName, constraint: IDSConstraint): OpBody {
  return { kind: 'value.set', payload: { facetId, field, value: { kind: 'raw', constraint } } };
}

export const VAL_001: SpecRule = {
  code: 'IDSL-VAL-001',
  area: 'VAL',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'error',
  title: 'Value not in the standard enumeration',
  rationale:
    "The standard property is an enumerated property and the required value is not one of its enumeration values. Enumeration values are compared case-sensitively, so conforming models can never carry it.",
  fix: 'Use the enumeration value with the same spelling in another case, or the closest one.',
  example: '<propertySet><simpleValue>Pset_DoorCommon</simpleValue></propertySet><baseName><simpleValue>Status</simpleValue></baseName><value><simpleValue>New</simpleValue></value>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const site of valueSites(ctx, spec)) {
      const f = site.view.facet;
      if (f.type !== 'property' || site.field !== 'property.value') continue;
      const psetName = single(f.propertySet);
      const name = single(f.baseName);
      if (!psetName || !name) continue;
      const values = siteLiterals(site.constraint);
      for (const v of spec.versions) {
        const prop = tables(ctx, v).psets.get(psetName)?.properties.find((p) => p.name === name);
        const allowed = prop?.kind === 'enumeration' ? prop.enumeration ?? [] : [];
        const bad = allowed.length ? values.filter((x) => !allowed.includes(x)) : [];
        if (!bad.length) continue;
        const fixes = bad.flatMap((x) => {
          const folded = allowed.find((a) => a.toLowerCase() === x.trim().toLowerCase());
          const picks = folded ? [folded] : rankCandidates(x, allowed, { minScore: 0.4, limit: 2 }).map((c) => c.value);
          return picks.map((p) => quickFix(`Use ${p}`, this.code, site.view.facetId, `${x}|${p}`, [rawSet(site.view.facetId, site.field, mapLiterals(site.constraint, (y) => (y === x ? p : y)))]));
        });
        out.push({ ...at(site.view, site.field), message: `${bad.map((x) => `"${x}"`).join(', ')} is not a value of ${psetName}.${name} (${v})`, fixes: gated(doc, ctx, fixes) });
        break;
      }
    }
    return out;
  },
};

/** The XSD base an IDS checker infers for a restriction (mirrors the audit). */
function inferredBase(c: IDSConstraint): string | undefined {
  if (c.type === 'simpleValue') return undefined;
  if (c.base) return c.base;
  if (c.type !== 'bounds') return 'xs:string';
  return c.length !== undefined || c.minLength !== undefined || c.maxLength !== undefined ? 'xs:string' : 'xs:double';
}

function compatible(inferred: string, backing: string): boolean {
  return inferred === backing || (FLOAT_XSD.has(inferred) && FLOAT_XSD.has(backing));
}

export const VAL_002: SpecRule = {
  code: 'IDSL-VAL-002',
  area: 'VAL',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Restriction base incompatible with the data type',
  rationale:
    "The restriction's base type (declared, or inferred: xs:string for patterns and enumerations, xs:double for numeric bounds) does not match the XSD type behind the property's dataType, for example numeric bounds on an IFCLABEL or a pattern on an IFCBOOLEAN. Values are cast to the data type before comparison, so the restriction cannot behave as written. The audit reports the same mismatch (E_RESTRICTION_BASE_MISMATCH).",
  fix: "Declare the data type's base on the restriction (offered only when every literal is valid under it).",
  example: '<property dataType="IFCLABEL">…<value><xs:restriction base="xs:double"><xs:minInclusive value="1"/></xs:restriction></value></property>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const site of valueSites(ctx, spec)) {
      if (site.field !== 'property.value' || !site.explicit || site.xsd.length !== 1) continue;
      const inferred = inferredBase(site.constraint);
      const [backing] = site.xsd;
      if (!inferred || compatible(inferred, backing) || site.constraint.type === 'simpleValue') continue;
      const fix = quickFix(`Use base ${backing}`, this.code, site.view.facetId, backing, [rawSet(site.view.facetId, site.field, { ...site.constraint, base: backing })]);
      out.push({ ...at(site.view, site.field), message: `restriction base ${inferred} does not fit ${site.dataType} (${backing})`, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};

const LIST_SEPARATOR = /\s*[,;|]\s*/;
const CODE_PAIR = /^[A-Za-z]+\d+(\s*\/\s*[A-Za-z]+\d+)+$/;

/** The items of a value that looks like a list, or undefined. */
export function listItems(value: string): string[] | undefined {
  const raw = value.trim();
  const bracketed = /^\[.*\]$/.test(raw) || /^\(.*\)$/.test(raw);
  const body = bracketed ? raw.slice(1, -1) : raw;
  if (CODE_PAIR.test(body)) return body.split('/').map((s) => s.trim());
  const items = body.split(LIST_SEPARATOR);
  if (items.length < 2 || items.some((i) => i === '' || !/[A-Za-z]/.test(i) || /\s/.test(i))) return undefined;
  const codeLike = items.every((i) => /\d/.test(i));
  return bracketed || codeLike || items.length >= 3 ? items : undefined;
}

export const VAL_003: SpecRule = {
  code: 'IDSL-VAL-003',
  area: 'VAL',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Simple value that looks like a list',
  rationale:
    'A simple value is compared as one exact string. "EI60, EI90", "[EI60, EI90]" or "EI60/EI90" therefore only matches elements carrying that whole text, never EI60 or EI90 alone. Alternatives are written as an enumeration.',
  fix: 'Convert to an enumeration of the items.',
  example: '<value><simpleValue>EI60, EI90</simpleValue></value>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const site of valueSites(ctx, spec)) {
      if (site.constraint.type !== 'simpleValue' || site.xsd.some((x) => NUMERIC_XSD.has(x))) continue;
      const items = listItems(site.constraint.value);
      if (!items) continue;
      const fix = quickFix('Convert to an enumeration', this.code, site.view.facetId, site.field, [
        rawSet(site.view.facetId, site.field, { type: 'enumeration', values: items, base: 'xs:string' }),
      ]);
      out.push({ ...at(site.view, site.field), message: `"${site.constraint.value}" looks like a list of ${items.length} values but is matched as one string`, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};

const COMPARISON = /^\s*(>=|<=|=>|=<|≥|≤|>|<)\s*([+-]?\d+(?:[.,]\d+)?)\s*([A-Za-z²³]*)\s*$/;

export interface Comparison {
  op: '>' | '>=' | '<' | '<=';
  value: number;
  unit?: string;
}

export function parseComparison(value: string): Comparison | undefined {
  const m = COMPARISON.exec(value);
  if (!m) return undefined;
  const op = ({ '>=': '>=', '=>': '>=', '≥': '>=', '<=': '<=', '=<': '<=', '≤': '<=', '>': '>', '<': '<' } as const)[m[1] as '>'];
  return { op, value: Number(m[2].replace(',', '.')), ...(m[3] ? { unit: m[3] } : {}) };
}

export const VAL_004: SpecRule = {
  code: 'IDSL-VAL-004',
  area: 'VAL',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Simple value that looks like a comparison',
  rationale: 'A simple value such as ">25" or "≥ 0.9" is compared as literal text, so it only matches an element whose value is that text. Numeric limits are written as bounds (minInclusive, maxExclusive, …).',
  fix: 'Convert to bounds (with the unit converted to SI when one is given).',
  example: '<value><simpleValue>&gt;= 30</simpleValue></value>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const site of valueSites(ctx, spec)) {
      if (site.constraint.type !== 'simpleValue') continue;
      const cmp = parseComparison(site.constraint.value);
      if (!cmp) continue;
      const lower = cmp.op.startsWith('>');
      const range = {
        kind: 'range' as const,
        ...(lower ? { min: cmp.value, minInclusive: cmp.op === '>=' } : { max: cmp.value, maxInclusive: cmp.op === '<=' }),
        ...(cmp.unit ? { unit: cmp.unit } : {}),
      };
      const fix = quickFix('Convert to bounds', this.code, site.view.facetId, site.field, [{ kind: 'value.set', payload: { facetId: site.view.facetId, field: site.field, value: range } }]);
      out.push({ ...at(site.view, site.field), message: `"${site.constraint.value}" is matched as text, not as a numeric comparison`, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};

const BOOLEAN_FORMS: Readonly<Record<string, 'true' | 'false'>> = {
  true: 'true', yes: 'true', y: 'true', ja: 'true', j: 'true', wahr: 'true', oui: 'true', vrai: 'true', si: 'true',
  false: 'false', no: 'false', n: 'false', nein: 'false', falsch: 'false', non: 'false', faux: 'false',
};

export const VAL_005: SpecRule = {
  code: 'IDSL-VAL-005',
  area: 'VAL',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Boolean literal in a form IDS does not accept',
  rationale:
    'IDS compares boolean values in their XSD lexical form, lower-case "true" and "false". "TRUE", "True", "yes" or "ja" never match (buildingSMART corpus: attribute/ and property/invalid-booleans_must_be_specified_as_lowercase_strings).',
  fix: 'Normalise to "true" / "false".',
  assumptions: [
    {
      id: 'A-04',
      verified:
        'buildingSMART corpus: pass-booleans_must_be_specified_as_lowercase_strings (attribute 3_3, property 2_3) accept "false"; fail-…_1_3 shows "true" is a comparable literal; invalid-…_2_3 / _3_3 mark "FALSE" as not conforming. The numeric forms 1/0 are not covered by the corpus and are not flagged.',
    },
  ],
  example: '<property dataType="IFCBOOLEAN">…<value><simpleValue>TRUE</simpleValue></value></property>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const site of valueSites(ctx, spec)) {
      const isBoolean = (site.xsd.length === 1 && site.xsd[0] === 'xs:boolean') || baseOf(site.constraint) === 'xs:boolean';
      if (!isBoolean) continue;
      const bad = siteLiterals(site.constraint).filter((v) => v !== 'true' && v !== 'false' && BOOLEAN_FORMS[v.trim().toLowerCase()]);
      if (!bad.length) continue;
      const fixed = mapLiterals(site.constraint, (v) => (bad.includes(v) ? BOOLEAN_FORMS[v.trim().toLowerCase()] : v));
      const fix = quickFix('Normalise to true / false', this.code, site.view.facetId, site.field, [rawSet(site.view.facetId, site.field, fixed)]);
      out.push({ ...at(site.view, site.field), message: `${bad.map((v) => `"${v}"`).join(', ')} is not a boolean literal IDS accepts (use "true" or "false")`, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};

const ODD_SPACE = /[  -​  　﻿]/;

function cleanLiteral(v: string): string {
  return v.replace(/[​﻿]/g, '').replace(/[  -   　]/g, ' ').trim();
}

export const VAL_006: SpecRule = {
  code: 'IDSL-VAL-006',
  area: 'VAL',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'info',
  title: 'Leading or trailing whitespace, or invisible characters',
  rationale:
    'String comparison in IDS is exact. A value with a leading or trailing space, a non-breaking space or a zero-width character (typical of copy-paste from documents and spreadsheets) does not match the visually identical value in a model.',
  fix: 'Trim the value and replace invisible characters.',
  example: '<simpleValue>EI60 </simpleValue>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const view of allFacets(spec)) {
      for (const field of ['entity.name', 'entity.predefinedType', 'attribute.name', 'attribute.value', 'property.propertySet', 'property.baseName', 'property.value', 'classification.system', 'classification.value', 'material.value', 'partOf.entity.name', 'partOf.entity.predefinedType'] as const) {
        const c = getField(view.facet, field);
        if (!c) continue;
        const bad = siteLiterals(c).filter((v) => v !== v.trim() || ODD_SPACE.test(v));
        if (!bad.length) continue;
        const fixed = mapLiterals(c, cleanLiteral);
        const fix = siteLiterals(fixed).some((v) => v === '') ? undefined : quickFix('Trim', this.code, view.facetId, field, [rawSet(view.facetId, field, fixed)]);
        out.push({ ...at(view, field), message: `${bad.map((v) => JSON.stringify(v)).join(', ')} has surrounding whitespace or invisible characters`, fixes: gated(doc, ctx, [fix]) });
      }
    }
    return out;
  },
};
