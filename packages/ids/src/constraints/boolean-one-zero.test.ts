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
import { matchConstraint } from './index.js';
import { literalCastsUnder, literalCastsUnderAnyType, ifcMeasureToXsdTypes } from './xsd-cast.js';
import { isValidLexicalForXsType } from './xsd-lexical.js';
import { checkAttributeFacet } from '../facets/attribute-facet.js';
import { checkPropertyFacet, propertyFacetPasses } from '../facets/property-facet.js';
import { createMockAccessor } from '../facets/test-helpers.js';
import type { IDSConstraint, IDSPropertyFacet, IDSSimpleValue } from '../types.js';

const sv = (value: string): IDSSimpleValue => ({ type: 'simpleValue', value });

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
