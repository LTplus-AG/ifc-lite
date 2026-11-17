/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A restriction follows a newly chosen dataType's XSD base only when it still holds under it. */

import { describe, expect, it } from 'vitest';
import { rebaseRestriction } from './values.js';

describe('rebaseRestriction', () => {
  it('moves an enumeration of integers with no base onto xs:integer', () => {
    expect(rebaseRestriction({ type: 'enumeration', values: ['1', '2', '3', '4', '5'] }, 'xs:integer'))
      .toEqual({ type: 'enumeration', values: ['1', '2', '3', '4', '5'], base: 'xs:integer' });
  });

  it('moves whole-number bounds onto xs:integer', () => {
    expect(rebaseRestriction({ type: 'bounds', minInclusive: 1, maxInclusive: 5 }, 'xs:integer'))
      .toEqual({ type: 'bounds', minInclusive: 1, maxInclusive: 5, base: 'xs:integer' });
  });

  it('leaves a restriction that would not hold under the new base', () => {
    expect(rebaseRestriction({ type: 'enumeration', values: ['A', 'B'] }, 'xs:integer')).toBeUndefined();
    expect(rebaseRestriction({ type: 'bounds', minInclusive: 1.5 }, 'xs:integer')).toBeUndefined();
    expect(rebaseRestriction({ type: 'bounds', minInclusive: 1 }, 'xs:string')).toBeUndefined();
    expect(rebaseRestriction({ type: 'bounds', maxLength: 5 }, 'xs:integer')).toBeUndefined();
    expect(rebaseRestriction({ type: 'bounds', minInclusive: 1, unparseableFacets: [{ facet: 'maxInclusive', rawValue: 'x' }] }, 'xs:integer')).toBeUndefined();
  });

  it('leaves a base whose literals are not checked, a pattern, and fractionDigits under xs:integer', () => {
    expect(rebaseRestriction({ type: 'enumeration', values: ['good', 'bad'] }, 'xs:date')).toBeUndefined();
    expect(rebaseRestriction({ type: 'enumeration', values: ['x'] }, 'xs:anyURI')).toBeUndefined();
    expect(rebaseRestriction({ type: 'pattern', pattern: '[A-Z]{2}' }, 'xs:integer')).toBeUndefined();
    expect(rebaseRestriction({ type: 'bounds', minInclusive: 1, fractionDigits: 2 }, 'xs:integer')).toBeUndefined();
    expect(rebaseRestriction({ type: 'bounds', minInclusive: 1, fractionDigits: 2 }, 'xs:decimal'))
      .toEqual({ type: 'bounds', minInclusive: 1, fractionDigits: 2, base: 'xs:decimal' });
  });

  it('leaves what XSD does not allow on the new base', () => {
    // xs:boolean takes no enumeration; xs:double and xs:float take no digits facets.
    expect(rebaseRestriction({ type: 'enumeration', values: ['true', 'false'] }, 'xs:boolean')).toBeUndefined();
    expect(rebaseRestriction({ type: 'bounds', minInclusive: 1, fractionDigits: 2 }, 'xs:double')).toBeUndefined();
    expect(rebaseRestriction({ type: 'bounds', minInclusive: 1, totalDigits: 3 }, 'xs:float')).toBeUndefined();
    expect(rebaseRestriction({ type: 'enumeration', values: ['1'], base: 'xs:integer', toleranceRule: 'ids11-418' }, 'xs:string')).toBeUndefined();
    expect(rebaseRestriction({ type: 'enumeration', values: ['1'], base: 'xs:double', toleranceRule: 'ids11-418' }, 'xs:integer')).toBeUndefined();
  });

  it('moves a string enumeration off a numeric base', () => {
    expect(rebaseRestriction({ type: 'enumeration', values: ['A'], base: 'xs:integer' }, 'xs:string'))
      .toEqual({ type: 'enumeration', values: ['A'], base: 'xs:string' });
  });

  it('leaves a value the writer already emits with that base', () => {
    expect(rebaseRestriction({ type: 'enumeration', values: ['A'] }, 'xs:string')).toBeUndefined();
    expect(rebaseRestriction({ type: 'bounds', minInclusive: 1 }, 'xs:double')).toBeUndefined();
  });

  it('leaves simple values, conjunctions and restrictions already on the base', () => {
    expect(rebaseRestriction({ type: 'simpleValue', value: '3' }, 'xs:integer')).toBeUndefined();
    expect(rebaseRestriction({ type: 'enumeration', values: ['1'], base: 'xs:integer' }, 'xs:integer')).toBeUndefined();
    expect(rebaseRestriction({ type: 'pattern', pattern: '[0-9]', and: [{ type: 'bounds', maxLength: 1 }] }, 'xs:integer')).toBeUndefined();
  });
});
