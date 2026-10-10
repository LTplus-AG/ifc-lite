/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IDSConstraint` -> `<simpleValue>` or one `<xs:restriction>` holding the
 * primary facet family and its conjunctive `and` siblings.
 */

import type { IDSConstraint } from '../types.js';
import type { XmlLines } from './xml-lines.js';

type RestrictionFamily = Exclude<IDSConstraint, { type: 'simpleValue' }>;

function refuse(what: string): never {
  throw new Error(`writeIdsXml: ${what} are not supported by this writer`);
}

/**
 * The facet families of one `<xs:restriction>`: the primary constraint and
 * its conjunctive `and` siblings (see `constraint-types.ts`). One restriction
 * holds one base and at most one family of each kind, since XSD ORs sibling
 * patterns and enumerations; anything else has no single-restriction XML and
 * is refused, never written as a weaker or different check.
 */
function restrictionFamilies(constraint: RestrictionFamily): RestrictionFamily[] {
  const families: RestrictionFamily[] = [constraint];
  for (const sibling of constraint.and ?? []) {
    if (sibling.type === 'simpleValue') refuse('simple values inside a conjunctive restriction');
    if (sibling.and?.length) refuse('nested conjunctive restriction facets');
    if (families.some((family) => family.type === sibling.type)) refuse(`two ${sibling.type} families in one conjunctive restriction`);
    families.push(sibling);
  }
  const bases = new Set(families.map((family) => family.base).filter((base) => base !== undefined));
  if (bases.size > 1) refuse('conjunctive restriction facets with different bases');
  return families;
}

/** `xs:length`, `xs:minLength`, `xs:maxLength` and the digit counts are `xs:nonNegativeInteger`. */
function countLexical(facet: string, value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`writeIdsXml: ${facet} must be a non-negative integer, got ${value}`);
  }
  return String(value);
}

/** Bases whose lexical space has an exponent: `xs:double` and `xs:float`. */
const EXPONENT_BASES = new Set(['xs:double', 'xs:float']);

/**
 * A bound in its base's lexical space. `String(1e-7)` is `"1e-7"`, which
 * `xs:decimal` and the integer types cannot read, so the exponent is expanded
 * into plain digits there; the digits are the same, so `parseFloat` reads
 * back the identical number.
 */
function boundLexical(facet: string, value: number, base: string): string {
  if (!Number.isFinite(value)) throw new Error(`writeIdsXml: ${facet} must be a finite number, got ${value}`);
  const text = String(value);
  if (EXPONENT_BASES.has(base) || !/e/i.test(text)) return text;
  return expandExponent(text);
}

function expandExponent(text: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(text);
  if (!match) return text;
  const [, sign, whole, fraction = '', exponentText] = match;
  const digits = whole + fraction;
  const point = whole.length + Number(exponentText);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

function writeBounds(xml: XmlLines, constraint: Extract<IDSConstraint, { type: 'bounds' }>, base: string): void {
  if (constraint.unparseableFacets?.length) refuse('unparseable bound facets');
  const bounds: Array<[string, number | undefined]> = [
    ['xs:minInclusive', constraint.minInclusive],
    ['xs:minExclusive', constraint.minExclusive],
    ['xs:maxInclusive', constraint.maxInclusive],
    ['xs:maxExclusive', constraint.maxExclusive],
  ];
  const counts: Array<[string, number | undefined]> = [
    ['xs:length', constraint.length],
    ['xs:minLength', constraint.minLength],
    ['xs:maxLength', constraint.maxLength],
    ['xs:totalDigits', constraint.totalDigits],
    ['xs:fractionDigits', constraint.fractionDigits],
  ];
  // With no facet the restriction would be empty, which reads back as an empty enumeration.
  if ([...bounds, ...counts].every(([, value]) => value === undefined)) refuse('bounds restrictions without any facet');
  for (const [facet, value] of bounds) {
    if (value !== undefined) xml.empty(facet, { value: boundLexical(facet, value, base) });
  }
  for (const [facet, value] of counts) {
    if (value !== undefined) xml.empty(facet, { value: countLexical(facet, value) });
  }
}

/** The base written when the model carries none: `xs:double` for a numeric bounds restriction, else `xs:string`. */
function defaultBase(families: readonly RestrictionFamily[]): string {
  const primary = families[0];
  if (primary.type !== 'bounds') return 'xs:string';
  const numeric = [primary.minInclusive, primary.minExclusive, primary.maxInclusive, primary.maxExclusive, primary.totalDigits, primary.fractionDigits];
  return numeric.some((value) => value !== undefined) ? 'xs:double' : 'xs:string';
}

function writeRestriction(xml: XmlLines, constraint: RestrictionFamily): void {
  const families = restrictionFamilies(constraint);
  const base = families.find((family) => family.base !== undefined)?.base ?? defaultBase(families);
  xml.open('xs:restriction', { base });
  for (const family of families) {
    switch (family.type) {
      case 'pattern':
        xml.empty('xs:pattern', { value: family.pattern });
        break;
      case 'enumeration':
        for (const value of family.values) xml.empty('xs:enumeration', { value });
        break;
      case 'bounds':
        writeBounds(xml, family, base);
        break;
    }
  }
  xml.close('xs:restriction');
}

export function writeConstraint(xml: XmlLines, tag: string, constraint: IDSConstraint): void {
  xml.open(tag);
  if (constraint.type === 'simpleValue') xml.leaf('simpleValue', constraint.value);
  else writeRestriction(xml, constraint);
  xml.close(tag);
}
