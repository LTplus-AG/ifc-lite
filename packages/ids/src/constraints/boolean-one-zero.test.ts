/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7543: the xs:boolean lexical space is {true, false, 1, 0} (XML Schema
 * Part 2, 3.2.2.1), and the audit accepted all four, but the cast gate and
 * `compareBoolean` took only `true` / `false`. A boolean written as `1` or
 * `0` passed the audit and then matched nothing: a requirement failed every
 * element, and an applicability selected none.
 *
 * Mock-accessor half. The parsed-model controls are in
 * `validation/boolean-one-zero.parsed-model.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { getConstraintMismatchReason, matchConstraint } from './index.js';
import { literalCastsUnder, literalCastsUnderAnyType, ifcMeasureToXsdTypes } from './xsd-cast.js';
import { isValidLexicalForXsType } from './xsd-lexical.js';
import { auditIDSStructure } from '../audit/index.js';
import { parseIDS } from '../parser/xml-parser.js';
import { checkAttributeFacet } from '../facets/attribute-facet.js';
import { checkPropertyFacet, propertyFacetPasses } from '../facets/property-facet.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import type { IDSConstraint, IDSPropertyFacet, IDSSimpleValue } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

/** An IDS whose one requirement is the IFCBOOLEAN property `Probe_Set.Flag`, with this `<value>` content. */
const idsWithValue = (value: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <info><title>#7543</title></info>
  <specifications>
    <specification name="S" ifcVersion="IFC4">
      <applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>
      <requirements><property dataType="IFCBOOLEAN"><propertySet><simpleValue>Probe_Set</simpleValue></propertySet><baseName><simpleValue>Flag</simpleValue></baseName><value>${value}</value></property></requirements>
    </specification>
  </specifications>
</ids>`;

/** The value constraint that `parseIDS` reads from `idsWithValue(value)`. */
function parsedValue(value: string): IDSConstraint {
  const facet = parseIDS(idsWithValue(value)).specifications[0].requirements[0].facet;
  if (facet.type !== 'property' || facet.value === undefined) throw new Error('fixture');
  return facet.value;
}

/**
 * Literals around the four valid ones: case, sign, leading zeros, empty, other
 * languages. Surrounding white space (' 1') is left out on purpose: xs:boolean
 * collapses it, the audit does not, and that is a separate question.
 */
const NEAR_MISSES = ['TRUE', 'True', 'FALSE', 'False', 'T', 'F', 'yes', 'no', '01', '00', '10', '+1', '-0', '1.0', '0.0', '1e0', '', '١'];

describe('xs:boolean literals 1 and 0 (#7543)', () => {
  it('the cast gate accepts exactly the four xs:boolean literals', () => {
    for (const v of ['true', 'false', '1', '0']) expect(literalCastsUnder(v, 'xs:boolean'), v).toBe(true);
    for (const v of NEAR_MISSES) expect(literalCastsUnder(v, 'xs:boolean'), JSON.stringify(v)).toBe(false);
  });

  it('the cast gate and the audit decide every literal the same way', () => {
    const disagreements = ['true', 'false', '1', '0', ...NEAR_MISSES]
      .filter((v) => literalCastsUnder(v, 'xs:boolean') !== isValidLexicalForXsType(v, 'xs:boolean'));
    expect(disagreements).toEqual([]);
  });

  // IFCLOGICAL: IDS 1.0 maps it to xs:string; IFC Lite also casts it as xs:boolean, so it follows here.
  it('IFCBOOLEAN and IFCLOGICAL properties accept 1 and 0 at the gate', () => {
    for (const measure of ['IFCBOOLEAN', 'IFCLOGICAL']) {
      for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3']) {
        expect(literalCastsUnderAnyType('1', ifcMeasureToXsdTypes(measure, schema))).toBe(true);
        expect(literalCastsUnderAnyType('0', ifcMeasureToXsdTypes(measure, schema))).toBe(true);
      }
    }
  });

  it('a simple value 1 or 0 matches the boolean it names, and only that one', () => {
    expect(matchConstraint(sv('1'), true)).toBe(true);
    expect(matchConstraint(sv('0'), false)).toBe(true);
    expect(matchConstraint(sv('1'), false)).toBe(false);
    expect(matchConstraint(sv('0'), true)).toBe(false);
  });

  it('case variants and other near misses still never match a boolean', () => {
    for (const v of NEAR_MISSES) {
      expect(matchConstraint(sv(v), true), JSON.stringify(v)).toBe(false);
      expect(matchConstraint(sv(v), false), JSON.stringify(v)).toBe(false);
    }
  });

  it('text stays text: 1 and 0 do not match a stored string that reads true or false', () => {
    expect(matchConstraint(sv('1'), 'true')).toBe(false);
    expect(matchConstraint(sv('0'), 'false')).toBe(false);
    // Unchanged: the canonical literal still matches its own text.
    expect(matchConstraint(sv('true'), 'true')).toBe(true);
  });

  it('numbers are still decided numerically, not as booleans', () => {
    expect(matchConstraint(sv('1'), 1)).toBe(true);
    expect(matchConstraint(sv('1'), 0)).toBe(false);
    expect(matchConstraint(sv('0'), 0)).toBe(true);
    expect(matchConstraint(sv('true'), 1)).toBe(false);
    expect(matchConstraint(sv('false'), 0)).toBe(false);
  });

  it('a string-only value (IFCLABEL) is not read as a boolean', () => {
    const constraint: IDSConstraint = sv('1');
    expect(matchConstraint(constraint, 'true', { stringOnly: true })).toBe(false);
    expect(matchConstraint(constraint, '1', { stringOnly: true })).toBe(true);
  });

  it('an enumeration that lists 1 or 0 matches the boolean it names', () => {
    const en = (values: string[], base?: string): IDSConstraint => ({ type: 'enumeration', values, ...(base ? { base } : {}) });
    // Matching does not read the base, as it already did not for numbers.
    // IfcTester (ifctester 0.8.3 on IfcOpenShell 0.8.4) also passes a stored
    // true against 1 listed under xs:string or xs:integer.
    for (const base of [undefined, 'xs:boolean', 'xs:string', 'xs:integer']) {
      const at = String(base);
      expect(matchConstraint(en(['1'], base), true), at).toBe(true);
      expect(matchConstraint(en(['0'], base), false), at).toBe(true);
      expect(matchConstraint(en(['1', '0'], base), false), at).toBe(true);
      expect(matchConstraint(en(['1'], base), false), at).toBe(false);
      expect(matchConstraint(en(['0'], base), true), at).toBe(false);
    }
    // Unchanged: a number is compared as a number, text as text.
    expect(matchConstraint(en(['1'], 'xs:integer'), 1)).toBe(true);
    expect(matchConstraint(en(['1'], 'xs:boolean'), 'true')).toBe(false);
    expect(matchConstraint(en(['1'], 'xs:boolean'), true, { stringOnly: true })).toBe(false);
  });

  it('getConstraintMismatchReason: once a listed 1 matches the stored boolean, the reason comes from the other facet', () => {
    // An enumeration with a pattern beside it, built by hand.
    const withPattern: IDSConstraint = {
      type: 'enumeration', values: ['1'], base: 'xs:boolean',
      and: [{ type: 'pattern', pattern: 'x', base: 'xs:boolean' }],
    };
    expect(getConstraintMismatchReason(withPattern, true)).toBe('"true" does not match pattern "x"');
    // Parsed: an enumeration with an xs:length beside it. The value still fails.
    const withLength = parsedValue('<xs:restriction base="xs:boolean"><xs:enumeration value="1"/><xs:length value="3"/></xs:restriction>');
    if (withLength.type !== 'enumeration' || withLength.and?.length !== 1) throw new Error('fixture');
    expect(matchConstraint(withLength, true)).toBe(false);
    expect(getConstraintMismatchReason(withLength, true)).toBe(getConstraintMismatchReason(withLength.and[0], true));
    // Unchanged: a parsed restriction puts an xs:pattern first, so the reason is the pattern's.
    const patternFirst = parsedValue('<xs:restriction base="xs:boolean"><xs:enumeration value="1"/><xs:pattern value="x"/></xs:restriction>');
    expect(getConstraintMismatchReason(patternFirst, true)).toBe('"true" does not match pattern "x"');
  });

  it('an xs:pattern is still matched against the text true or false', () => {
    const pattern = (value: string): IDSConstraint => ({ type: 'pattern', pattern: value, base: 'xs:boolean' });
    expect(matchConstraint(pattern('true'), true)).toBe(true);
    expect(matchConstraint(pattern('false'), false)).toBe(true);
    expect(matchConstraint(pattern('1'), true)).toBe(false);
    expect(matchConstraint(pattern('0'), false)).toBe(false);
  });
});

describe('the audit keeps its answers (#7543)', () => {
  // The audit's xs:boolean check reads the shared table now. The regex it
  // replaced read the value as text, so a value that is not a string (a
  // caller can put one into a parsed document) must keep that answer.
  const xml = idsWithValue('<xs:restriction base="xs:boolean"><xs:enumeration value="true"/></xs:restriction>');
  /** The `E_RESTRICTION_VALUE_MISMATCH` issues for the enumeration holding only `value`. */
  async function mismatches(value: unknown): Promise<number> {
    const doc = parseIDS(xml);
    const facet = doc.specifications[0].requirements[0].facet;
    if (facet.type !== 'property' || facet.value?.type !== 'enumeration') throw new Error('fixture');
    Object.assign(facet.value, { values: [value] });
    return (await auditIDSStructure(doc)).issues.filter((i) => i.code === 'E_RESTRICTION_VALUE_MISMATCH').length;
  }

  it('an xs:boolean enumeration value that is not a string is read as text, as before', async () => {
    expect(await mismatches('1')).toBe(0);
    expect(await mismatches(1)).toBe(0);
    expect(await mismatches(true)).toBe(0);
    // The check still runs: these were flagged before and still are.
    expect(await mismatches(2)).toBe(1);
    expect(await mismatches('TRUE')).toBe(1);
  });
});

describe('facets with 1 and 0 on a mock accessor (#7543)', () => {
  const accessor = createMockAccessor([
    {
      expressId: 1,
      type: 'IfcWall',
      properties: [
        { psetName: 'Probe_Set', propName: 'Flag', value: true, dataType: 'IFCBOOLEAN' },
        { psetName: 'Probe_Set', propName: 'Off', value: false, dataType: 'IFCBOOLEAN' },
        { psetName: 'Probe_Set', propName: 'Logical', value: true, dataType: 'IFCLOGICAL' },
        { psetName: 'Probe_Set', propName: 'Label', value: 'true', dataType: 'IFCLABEL' },
      ],
    },
    {
      expressId: 2,
      type: 'IfcTask',
      attributes: { IsMilestone: true },
      attributeXsdTypes: { IsMilestone: ['xs:boolean'] },
    },
  ]);
  const prop = (baseName: string, dataType: string, value: IDSConstraint): IDSPropertyFacet => ({
    type: 'property', propertySet: sv('Probe_Set'), baseName: sv(baseName), dataType: sv(dataType), value,
  });
  /** Both gates must agree: `checkPropertyFacet` and its diagnostics-free twin. */
  const both = (facet: IDSPropertyFacet): [boolean, boolean] => [
    checkPropertyFacet(facet, 1, accessor).passed,
    propertyFacetPasses(facet, 1, accessor),
  ];

  it('IFCBOOLEAN properties pass with 1 and 0 and fail with the opposite value', () => {
    expect(both(prop('Flag', 'IFCBOOLEAN', sv('1')))).toEqual([true, true]);
    expect(both(prop('Off', 'IFCBOOLEAN', sv('0')))).toEqual([true, true]);
    expect(both(prop('Flag', 'IFCBOOLEAN', sv('0')))).toEqual([false, false]);
    expect(both(prop('Off', 'IFCBOOLEAN', sv('1')))).toEqual([false, false]);
  });

  it('an IFCLOGICAL property, which IFC Lite casts as xs:boolean too, passes with 1', () => {
    expect(both(prop('Logical', 'IFCLOGICAL', sv('1')))).toEqual([true, true]);
  });

  it('an IFCLABEL property that reads true is not matched by 1', () => {
    expect(both(prop('Label', 'IFCLABEL', sv('1')))).toEqual([false, false]);
  });

  it('a boolean attribute passes with 1 and fails with 0', () => {
    const attribute = (value: string) =>
      checkAttributeFacet({ type: 'attribute', name: sv('IsMilestone'), value: sv(value) }, 2, accessor);
    expect(attribute('1').passed).toBe(true);
    const failed = attribute('0');
    expect(failed.passed).toBe(false);
    expect(failed.failure?.type).toBe('ATTRIBUTE_VALUE_MISMATCH');
  });
});
