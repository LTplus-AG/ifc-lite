/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Pattern rules IDSL-REGEX-001 … 004. */

import type { IDSConstraint, IDSPatternConstraint } from '@ifc-lite/ids';
import { assertGuardedRegexPattern, UnsafeRegexPatternError } from '@ifc-lite/regex-guard';
import { ALL_FACET_FIELDS, getField, type FacetFieldName } from '../../document/fields.js';
import { quickFix } from '../fix.js';
import type { FacetView, Finding, SpecRule, SpecView } from '../types.js';
import { allFacets, at } from '../walk.js';
import { gated } from './util.js';
import { rawSet } from './values.js';
import { literalOf, tokenizeXsdPattern, type XsdToken } from './xsd-regex.js';

interface PatternSite {
  view: FacetView;
  field: FacetFieldName;
  constraint: IDSConstraint;
  pattern: string;
  /** The primary family of the constraint (fixable); false for an `and` sibling. */
  primary: boolean;
}

function patternSites(spec: SpecView): PatternSite[] {
  const out: PatternSite[] = [];
  for (const view of allFacets(spec)) {
    for (const field of ALL_FACET_FIELDS) {
      const c = getField(view.facet, field);
      if (!c) continue;
      if (c.type === 'pattern') out.push({ view, field, constraint: c, pattern: c.pattern, primary: true });
      if (c.type !== 'simpleValue') {
        for (const s of c.and ?? []) if (s.type === 'pattern') out.push({ view, field, constraint: c, pattern: s.pattern, primary: false });
      }
    }
  }
  return out;
}

function withPattern(c: IDSConstraint, pattern: string): IDSPatternConstraint | undefined {
  return c.type === 'pattern' ? { ...c, pattern } : undefined;
}

function fixPattern(rule: SpecRule, site: PatternSite, label: string, pattern: string) {
  const next = site.primary ? withPattern(site.constraint, pattern) : undefined;
  return next && pattern !== '' ? quickFix(label, rule.code, site.view.facetId, `${site.field}|${pattern}`, [rawSet(site.view.facetId, site.field, next)]) : undefined;
}

export const REGEX_001: SpecRule = {
  code: 'IDSL-REGEX-001',
  area: 'REGEX',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: '^ or $ in an XSD pattern',
  rationale:
    'XSD patterns are implicitly anchored: the whole value must match. "^" and "$" are not anchors there but ordinary characters, so "^EI.*$" only matches values that literally start with "^" and end with "$".',
  fix: 'Remove the leading ^ and trailing $.',
  references: ['https://www.w3.org/TR/xmlschema-2/#regexs'],
  example: '<xs:pattern value="^EI[0-9]+$"/>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const site of patternSites(spec)) {
      const tokens = tokenizeXsdPattern(site.pattern);
      const anchors = tokens.filter((t) => t.kind === 'caret' || t.kind === 'dollar');
      if (!anchors.length) continue;
      const edgeOnly = anchors.every((t) => (t.kind === 'caret' && t.start === 0) || (t.kind === 'dollar' && t.start === site.pattern.length - 1));
      const fix = edgeOnly ? fixPattern(this, site, 'Remove the anchors', site.pattern.replace(/^\^/, '').replace(/\$$/, '')) : undefined;
      out.push({ ...at(site.view, site.field), message: `pattern "${site.pattern}" contains ${anchors.map((t) => t.text).join(' and ')}, which XSD treats as literal characters`, fixes: gated(doc, ctx, [fix]) });
    }
    return out;
  },
};

const VALUE_FIELDS = new Set<FacetFieldName>(['attribute.value', 'property.value', 'classification.value', 'material.value']);
const MATCH_ALL = /^(\.\*)+$/;

export const REGEX_002: SpecRule = {
  code: 'IDSL-REGEX-002',
  area: 'REGEX',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Pattern that is a plain value or matches everything',
  rationale:
    'A pattern without any regex construct ("FireRating") is the same as a simple value, which is easier to read, translate and check. A value pattern of ".*" accepts every value, so it adds nothing to an existence check. (A ".*" around other text is meaningful in XSD, "contains", and is not flagged.)',
  fix: 'Replace by a simple value, or drop the value so only existence is checked.',
  example: '<value><xs:restriction base="xs:string"><xs:pattern value="EI60"/></xs:restriction></value>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const site of patternSites(spec)) {
      if (!site.primary || site.constraint.type !== 'pattern' || site.constraint.and?.length) continue;
      const literal = literalOf(site.pattern);
      if (literal !== undefined && /\p{L}/u.test(literal)) {
        const fix = quickFix(`Use the simple value "${literal}"`, this.code, site.view.facetId, site.field, [rawSet(site.view.facetId, site.field, { type: 'simpleValue', value: literal })]);
        out.push({ ...at(site.view, site.field), message: `pattern "${site.pattern}" has no regex constructs; it is the simple value "${literal}"`, fixes: gated(doc, ctx, [fix]) });
      } else if (MATCH_ALL.test(site.pattern) && VALUE_FIELDS.has(site.field)) {
        const fix = quickFix('Check existence only', this.code, site.view.facetId, site.field, [{ kind: 'facet.setField', payload: { facetId: site.view.facetId, field: site.field, value: null } }]);
        out.push({ ...at(site.view, site.field), message: `pattern "${site.pattern}" accepts any value`, fixes: gated(doc, ctx, [fix]) });
      }
    }
    return out;
  },
};

function unsupported(t: XsdToken): boolean {
  return t.kind === 'openSpecial' || t.kind === 'lazy' || t.kind === 'invalidEscape';
}

/** An escaped punctuation character that is not an XSD metacharacter, e.g. `\/`. */
function redundantEscape(t: XsdToken): boolean {
  return t.kind === 'invalidEscape' && t.text.length === 2 && /[^\p{L}\p{N}\s]/u.test(t.text[1]);
}

/**
 * Constructs outside XSD 1.0 that the .NET- and JS-based reference tools
 * read the same way, and that the buildingSMART corpus uses in pass- cases
 * (restriction/pass-regex_patterns_work_in_OR_*: `(?:…)`; property/…: `\/`).
 */
function portable(t: XsdToken): boolean {
  return (t.kind === 'openSpecial' && t.text === '(?:') || redundantEscape(t);
}

/** Rewrite `(?:` → `(` and drop lazy markers; undefined when other unsupported constructs remain. */
function rewrite(pattern: string, tokens: XsdToken[]): string | undefined {
  let out = '';
  for (const t of tokens) {
    if (t.kind === 'openSpecial') {
      if (t.text !== '(?:') return undefined;
      out += '(';
    } else if (t.kind === 'lazy') {
      if (t.text !== '?') return undefined;
    } else if (t.kind === 'invalidEscape') {
      if (!redundantEscape(t)) return undefined;
      out += t.text[1];
    } else {
      out += t.text;
    }
  }
  return out === pattern ? undefined : out;
}

export const REGEX_003: SpecRule = {
  code: 'IDSL-REGEX-003',
  area: 'REGEX',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'warning',
  title: 'Construct not supported by XSD regex',
  rationale:
    'XSD regex has no lookarounds, non-capturing or named groups, backreferences, word boundaries (\\b), lazy quantifiers or escapes of ordinary characters. A checker that implements XSD regex strictly rejects such a pattern or reads it differently. Non-capturing groups and escaped punctuation (\\/) are read the same way by the common reference tools and appear in buildingSMART pass- test cases, so those findings are info only. Note that \\d and \\w are Unicode classes in XSD and \\w excludes the underscore.',
  fix: 'Rewrite (?:…) as (…) and drop lazy markers (an anchored full match is the same either way); other constructs need a manual rewrite.',
  references: ['https://www.w3.org/TR/xmlschema-2/#regexs'],
  example: '<xs:pattern value="(?:EI|REI)[0-9]+"/>',
  check(spec, { ctx, doc }) {
    const out: Finding[] = [];
    for (const site of patternSites(spec)) {
      const tokens = tokenizeXsdPattern(site.pattern);
      const bad = tokens.filter(unsupported);
      if (!bad.length) continue;
      const rewritten = rewrite(site.pattern, tokens);
      const fix = rewritten ? fixPattern(this, site, `Rewrite as "${rewritten}"`, rewritten) : undefined;
      out.push({
        ...at(site.view, site.field),
        ...(bad.every(portable) ? { severity: 'info' as const } : {}),
        message: `pattern "${site.pattern}" uses ${[...new Set(bad.map((t) => t.text))].join(', ')}, not part of XSD regex`,
        fixes: gated(doc, ctx, [fix]),
      });
    }
    return out;
  },
};

export const REGEX_004: SpecRule = {
  code: 'IDSL-REGEX-004',
  area: 'REGEX',
  scope: 'spec',
  kind: 'static',
  defaultSeverity: 'error',
  title: 'Catastrophic backtracking risk',
  rationale:
    'The pattern has a shape (nested or overlapping quantifiers, excessive length) that the shared ReDoS guard rejects: a backtracking engine can take exponential time on it. ifc-lite refuses to run it, and other checkers may hang.',
  example: '<xs:pattern value="(a+)+b"/>',
  check(spec) {
    const out: Finding[] = [];
    for (const site of patternSites(spec)) {
      try {
        assertGuardedRegexPattern(site.pattern);
      } catch (err) {
        if (!(err instanceof UnsafeRegexPatternError)) throw err;
        out.push({ ...at(site.view, site.field), message: `pattern "${site.pattern}" is rejected by the ReDoS guard: ${err.reason}` });
      }
    }
    return out;
  },
};
