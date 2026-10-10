/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `<xs:restriction>` element parsing — split out of `xml-parser.ts`
 * (module-size budget).
 */

import type {
  IDSConstraint,
  IDSPatternConstraint,
  IDSEnumerationConstraint,
  IDSBoundsConstraint,
} from '../types.js';

import { boundOrderOf, readNumeric, readOrderedLexeme } from '../constraints/xsd-order.js';
import {
  getChildElement,
  getChildElements,
  getChildElementNS,
  getChildElementsNS,
} from './dom.js';

const XS_NAMESPACE = 'http://www.w3.org/2001/XMLSchema';

const BOUND_FACETS = ['minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive'] as const;
type BoundFacet = (typeof BOUND_FACETS)[number];

/** `xs:nonNegativeInteger`'s lexical space (an optional `+`, then digits). */
const NON_NEGATIVE_INTEGER = /^\+?\d+$/;

/**
 * Parse XSD restriction element.
 *
 * XSD facets inside one `<xs:restriction>` are conjunctive — a value
 * must satisfy every one. `parseRestrictionFamilies` yields one
 * `IDSConstraint` per facet family present (pattern, enumeration,
 * bounds/length); this joins them, keeping the first as the primary so
 * every existing `switch (constraint.type)` in `audit/`, `translation/`
 * and the facet checkers keeps seeing the shape it already handles, and
 * hanging the rest off `and` for `matchConstraint` to require as well.
 */
export function parseRestriction(el: Element): IDSConstraint {
  const [primary, ...rest] = parseRestrictionFamilies(el);
  if (!primary) {
    // `parseRestrictionFamilies` always returns at least one family.
    return { type: 'enumeration', values: [] } satisfies IDSEnumerationConstraint;
  }
  if (rest.length === 0) return primary;
  // Only a restriction-derived family can have siblings, and
  // `simpleValue` is never one — it is the text-content fallback, which
  // is returned alone.
  if (primary.type === 'simpleValue') return primary;
  return { ...primary, and: rest };
}

function parseRestrictionFamilies(el: Element): IDSConstraint[] {
  const out: IDSConstraint[] = [];
  // Capture the `@base` attribute so the auditor can compare against
  // an IFC dataType's backing XSD type without inferring from the
  // restriction shape (which is ambiguous for numeric enumerations).
  const base = el.getAttribute('base') || undefined;

  // Check for pattern(s). Multiple `<xs:pattern>` siblings inside a
  // single restriction are OR'd per the XSD spec, so collect every
  // candidate and join them with `|` (each wrapped in a non-capturing
  // group so anchors apply uniformly).
  const patternEls = (() => {
    const ns = getChildElementsNS(el, 'pattern', XS_NAMESPACE);
    if (ns.length > 0) return ns;
    return getChildElements(el, 'pattern');
  })();
  if (patternEls.length > 0) {
    const parts = patternEls
      .map((p) => p.getAttribute('value') || p.textContent || '')
      .filter((s) => s.length > 0);
    const pattern =
      parts.length === 1
        ? parts[0]
        : parts.map((p) => `(?:${p})`).join('|');
    out.push({
      type: 'pattern',
      pattern,
      base,
    } satisfies IDSPatternConstraint);
  }

  // Check for enumeration
  const enumEls = getChildElementsNS(el, 'enumeration', XS_NAMESPACE);
  if (enumEls.length === 0) {
    // Try without namespace
    const enumElsNoNS = getChildElements(el, 'enumeration');
    if (enumElsNoNS.length > 0) {
      out.push({
        type: 'enumeration',
        values: enumElsNoNS.map(
          (e) => e.getAttribute('value') || e.textContent || ''
        ),
        base,
      } satisfies IDSEnumerationConstraint);
    }
  } else {
    out.push({
      type: 'enumeration',
      values: enumEls.map(
        (e) => e.getAttribute('value') || e.textContent || ''
      ),
      base,
    } satisfies IDSEnumerationConstraint);
  }

  // Check for bounds (minInclusive, maxInclusive, minExclusive,
  // maxExclusive, length, minLength, maxLength, totalDigits,
  // fractionDigits).
  const facetEls: Record<string, Element | null> = {};
  for (const facet of [
    'minInclusive',
    'maxInclusive',
    'minExclusive',
    'maxExclusive',
    'length',
    'minLength',
    'maxLength',
    'totalDigits',
    'fractionDigits',
  ]) {
    facetEls[facet] =
      getChildElementNS(el, facet, XS_NAMESPACE) ||
      getChildElement(el, facet);
  }

  if (Object.values(facetEls).some((e) => e !== null)) {
    const bounds: IDSBoundsConstraint = { type: 'bounds', base };
    // Facets present in the XML whose `@value` failed to parse — kept
    // separate from a facet that was simply never present, so
    // `matchBounds` can fail closed instead of silently treating a
    // botched restriction as unbounded (an unparseable minInclusive
    // must NOT read the same as no minInclusive at all).
    const unparseable: { facet: string; rawValue: string }[] = [];
    const rawValueOf = (e: Element): string =>
      e.getAttribute('value') || e.textContent || '';
    // A min/max bound is read in the lexical space of the restriction's
    // `@base`, never by `parseFloat` — which read `2024-03-31` as 2024 and
    // `6,5` as 6 (#7399). A bound outside that space is recorded as
    // unparseable, so the restriction fails closed and the audit names it.
    const order = boundOrderOf(base);
    const readBound = (facet: BoundFacet): void => {
      const e = facetEls[facet];
      if (!e) return;
      const raw = rawValueOf(e);
      if (order === 'numeric') {
        const v = readNumeric(raw, base);
        if (v !== undefined) bounds[facet] = v;
        else unparseable.push({ facet, rawValue: raw });
        return;
      }
      const lexeme = readOrderedLexeme(raw, base);
      if (lexeme !== undefined) (bounds.temporalBounds ??= {})[facet] = lexeme;
      else unparseable.push({ facet, rawValue: raw });
    };
    // A length or digit count is an `xs:nonNegativeInteger`: the whole
    // text, not the leading digits `parseInt` would take from `"6,5"`.
    const readInt = (facet: string, e: Element | null): number | undefined => {
      if (!e) return undefined;
      const raw = rawValueOf(e);
      const text = raw.trim();
      if (NON_NEGATIVE_INTEGER.test(text)) return Number(text);
      unparseable.push({ facet, rawValue: raw });
      return undefined;
    };
    for (const facet of BOUND_FACETS) readBound(facet);
    bounds.length = readInt('length', facetEls.length);
    bounds.minLength = readInt('minLength', facetEls.minLength);
    bounds.maxLength = readInt('maxLength', facetEls.maxLength);
    bounds.totalDigits = readInt('totalDigits', facetEls.totalDigits);
    bounds.fractionDigits = readInt('fractionDigits', facetEls.fractionDigits);
    if (unparseable.length > 0) bounds.unparseableFacets = unparseable;
    out.push(bounds);
  }

  if (out.length > 0) return out;

  // No recognised pattern/enumeration/bounds child. If the element carries
  // no text at all (the common "empty restriction" authoring mistake —
  // e.g. `<xs:restriction base="xs:string"/>`, or the same thing
  // pretty-printed with only indentation whitespace between the tags),
  // surface an empty enumeration so the coherence auditor can flag it —
  // presence is decided on the TRIMMED text so indentation whitespace
  // doesn't masquerade as authored content. Otherwise fall through to the
  // RAW text kept verbatim, not trimmed: `xs:string` whitespace inside a
  // real value is significant, same rule as `xml-parser.ts` (#6117/#6153).
  const rawText = el.textContent ?? '';
  const hasText = rawText.trim() !== '';
  if (!hasText) {
    return [
      {
        type: 'enumeration',
        values: [],
        base,
      } satisfies IDSEnumerationConstraint,
    ];
  }
  return [{ type: 'simpleValue', value: rawText }];
}
