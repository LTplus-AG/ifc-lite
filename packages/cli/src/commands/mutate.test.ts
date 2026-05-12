/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  parseWhereFilter,
  parseSetArg,
  coerceValue,
  matchesFilter,
  splitStepArgs,
} from './mutate.js';
import { PropertyValueType } from '@ifc-lite/data';

describe('parseWhereFilter', () => {
  it('parses equals filter', () => {
    const result = parseWhereFilter('Pset_WallCommon.IsExternal=true');
    expect(result).toEqual({
      psetName: 'Pset_WallCommon',
      propName: 'IsExternal',
      operator: '=',
      value: 'true',
    });
  });

  it('parses not-equals filter', () => {
    const result = parseWhereFilter('Pset_WallCommon.IsExternal!=true');
    expect(result).toEqual({
      psetName: 'Pset_WallCommon',
      propName: 'IsExternal',
      operator: '!=',
      value: 'true',
    });
  });

  it('parses greater-than filter', () => {
    const result = parseWhereFilter('Qto_WallBaseQuantities.Height>2.5');
    expect(result).toEqual({
      psetName: 'Qto_WallBaseQuantities',
      propName: 'Height',
      operator: '>',
      value: '2.5',
    });
  });

  it('parses less-than filter', () => {
    const result = parseWhereFilter('Qto_SlabBaseQuantities.Width<1');
    expect(result).toEqual({
      psetName: 'Qto_SlabBaseQuantities',
      propName: 'Width',
      operator: '<',
      value: '1',
    });
  });

  it('parses greater-or-equal filter', () => {
    const result = parseWhereFilter('CustomPset.Value>=100');
    expect(result).toEqual({
      psetName: 'CustomPset',
      propName: 'Value',
      operator: '>=',
      value: '100',
    });
  });

  it('parses less-or-equal filter', () => {
    const result = parseWhereFilter('CustomPset.Value<=50');
    expect(result).toEqual({
      psetName: 'CustomPset',
      propName: 'Value',
      operator: '<=',
      value: '50',
    });
  });

  it('parses contains filter (tilde)', () => {
    const result = parseWhereFilter('Pset_WallCommon.Reference~concrete');
    expect(result).toEqual({
      psetName: 'Pset_WallCommon',
      propName: 'Reference',
      operator: 'contains',
      value: 'concrete',
    });
  });

  it('parses exists filter (no operator)', () => {
    const result = parseWhereFilter('Pset_WallCommon.IsExternal');
    expect(result).toEqual({
      psetName: 'Pset_WallCommon',
      propName: 'IsExternal',
      operator: 'exists',
    });
  });

  it('throws for missing dot separator', () => {
    expect(() => parseWhereFilter('NoDotHere=value')).toThrow();
  });

  it('throws for dot at position 0', () => {
    expect(() => parseWhereFilter('.PropName=value')).toThrow();
  });

  it('handles pset names with underscores', () => {
    const result = parseWhereFilter('My_Custom_Pset.SomeProp=123');
    expect(result.psetName).toBe('My_Custom_Pset');
    expect(result.propName).toBe('SomeProp');
    expect(result.value).toBe('123');
  });

  it('handles empty value after operator', () => {
    const result = parseWhereFilter('Pset.Prop=');
    expect(result.value).toBe('');
  });
});

describe('parseSetArg', () => {
  it('parses pset.prop=value form', () => {
    const result = parseSetArg('Pset_WallCommon.IsExternal=true');
    expect(result).toEqual({
      psetName: 'Pset_WallCommon',
      propName: 'IsExternal',
      value: 'true',
      isAttribute: false,
    });
  });

  it('parses attribute form (no dot)', () => {
    const result = parseSetArg('Name=TestWall');
    expect(result).toEqual({
      psetName: null,
      propName: 'Name',
      value: 'TestWall',
      isAttribute: true,
    });
  });

  it('parses Description attribute', () => {
    const result = parseSetArg('Description=A test description');
    expect(result).toEqual({
      psetName: null,
      propName: 'Description',
      value: 'A test description',
      isAttribute: true,
    });
  });

  it('handles value containing dots', () => {
    // Dot comes after = sign, so it's an attribute mutation
    const result = parseSetArg('Name=wall.v2');
    expect(result.isAttribute).toBe(true);
    expect(result.propName).toBe('Name');
    expect(result.value).toBe('wall.v2');
  });

  it('handles numeric values', () => {
    const result = parseSetArg('CustomPset.Height=3.5');
    expect(result.psetName).toBe('CustomPset');
    expect(result.propName).toBe('Height');
    expect(result.value).toBe('3.5');
  });

  it('throws for missing equals sign', () => {
    expect(() => parseSetArg('PsetName.PropName')).toThrow();
  });

  it('throws for equals at position 0', () => {
    expect(() => parseSetArg('=value')).toThrow();
  });

  it('handles value with equals sign in it', () => {
    // "Pset.Prop=a=b" should parse as pset=Pset, prop=Prop, value=a=b
    const result = parseSetArg('Pset.Prop=a=b');
    expect(result.psetName).toBe('Pset');
    expect(result.propName).toBe('Prop');
    expect(result.value).toBe('a=b');
  });
});

describe('coerceValue', () => {
  it('coerces "true" to boolean true', () => {
    const result = coerceValue('true');
    expect(result.coerced).toBe(true);
    expect(result.valueType).toBe(PropertyValueType.Boolean);
  });

  it('coerces "false" to boolean false', () => {
    const result = coerceValue('false');
    expect(result.coerced).toBe(false);
    expect(result.valueType).toBe(PropertyValueType.Boolean);
  });

  it('coerces integer string to number', () => {
    const result = coerceValue('42');
    expect(result.coerced).toBe(42);
  });

  it('coerces float string to number', () => {
    const result = coerceValue('3.14');
    expect(result.coerced).toBe(3.14);
  });

  it('coerces negative number string', () => {
    const result = coerceValue('-5');
    expect(result.coerced).toBe(-5);
  });

  it('returns string for non-numeric, non-boolean input', () => {
    const result = coerceValue('hello');
    expect(result.coerced).toBe('hello');
  });

  it('distinguishes integer vs real value types', () => {
    const intResult = coerceValue('10');
    const realResult = coerceValue('10.5');
    // Integer and Real have different PropertyValueType values
    expect(intResult.valueType).not.toBe(realResult.valueType);
  });
});

describe('matchesFilter', () => {
  it('exists operator returns true for non-null', () => {
    expect(matchesFilter('anything', 'exists')).toBe(true);
    expect(matchesFilter(0, 'exists')).toBe(true);
    expect(matchesFilter(false, 'exists')).toBe(true);
  });

  it('exists operator returns false for null/undefined', () => {
    expect(matchesFilter(null, 'exists')).toBe(false);
    expect(matchesFilter(undefined, 'exists')).toBe(false);
  });

  it('equality with strings', () => {
    expect(matchesFilter('hello', '=', 'hello')).toBe(true);
    expect(matchesFilter('hello', '=', 'world')).toBe(false);
  });

  it('equality with numbers', () => {
    expect(matchesFilter(42, '=', '42')).toBe(true);
    expect(matchesFilter(42, '=', '43')).toBe(false);
  });

  it('inequality', () => {
    expect(matchesFilter('a', '!=', 'b')).toBe(true);
    expect(matchesFilter('a', '!=', 'a')).toBe(false);
    expect(matchesFilter(1, '!=', '2')).toBe(true);
  });

  it('greater than', () => {
    expect(matchesFilter(10, '>', '5')).toBe(true);
    expect(matchesFilter(5, '>', '10')).toBe(false);
    expect(matchesFilter(5, '>', '5')).toBe(false);
  });

  it('less than', () => {
    expect(matchesFilter(3, '<', '5')).toBe(true);
    expect(matchesFilter(5, '<', '3')).toBe(false);
    expect(matchesFilter(5, '<', '5')).toBe(false);
  });

  it('greater or equal', () => {
    expect(matchesFilter(10, '>=', '10')).toBe(true);
    expect(matchesFilter(11, '>=', '10')).toBe(true);
    expect(matchesFilter(9, '>=', '10')).toBe(false);
  });

  it('less or equal', () => {
    expect(matchesFilter(10, '<=', '10')).toBe(true);
    expect(matchesFilter(9, '<=', '10')).toBe(true);
    expect(matchesFilter(11, '<=', '10')).toBe(false);
  });

  it('contains (case-insensitive)', () => {
    expect(matchesFilter('Hello World', 'contains', 'hello')).toBe(true);
    expect(matchesFilter('Hello World', 'contains', 'WORLD')).toBe(true);
    expect(matchesFilter('Hello', 'contains', 'xyz')).toBe(false);
  });

  it('returns false for null actual value with non-exists operator', () => {
    expect(matchesFilter(null, '=', 'value')).toBe(false);
    expect(matchesFilter(null, '>', '5')).toBe(false);
  });

  it('returns false for unknown operator', () => {
    expect(matchesFilter('a', 'unknown', 'a')).toBe(false);
  });

  it('returns false for non-numeric comparison with > or <', () => {
    expect(matchesFilter('abc', '>', 'def')).toBe(false);
    expect(matchesFilter('abc', '<', 'def')).toBe(false);
  });
});

describe('splitStepArgs', () => {
  it('splits simple comma-separated values', () => {
    expect(splitStepArgs("'abc',123,$,.T.")).toEqual(["'abc'", '123', '$', '.T.']);
  });

  it('handles nested parentheses', () => {
    expect(splitStepArgs("'hello',(1,2,3),$")).toEqual(["'hello'", '(1,2,3)', '$']);
  });

  it('handles quoted strings with commas', () => {
    expect(splitStepArgs("'hello, world',42")).toEqual(["'hello, world'", '42']);
  });

  it('handles escaped quotes in strings (doubled single quotes)', () => {
    expect(splitStepArgs("'it''s a test',99")).toEqual(["'it''s a test'", '99']);
  });

  it('handles empty input', () => {
    expect(splitStepArgs('')).toEqual([]);
  });

  it('handles single value', () => {
    expect(splitStepArgs('42')).toEqual(['42']);
  });

  it('handles deeply nested parens', () => {
    expect(splitStepArgs('#1,IFCWALL((1,(2,3)),4),#5')).toEqual(['#1', 'IFCWALL((1,(2,3)),4)', '#5']);
  });

  it('handles STEP null ($) and derived (*) markers', () => {
    expect(splitStepArgs('$,$,*')).toEqual(['$', '$', '*']);
  });

  it('handles entity references', () => {
    expect(splitStepArgs('#1,#2,#3')).toEqual(['#1', '#2', '#3']);
  });

  it('handles mixed content typical of IFC STEP lines', () => {
    const result = splitStepArgs("'2aG1gNarLHm9Qs6Q3z97P1',#2,'Wall-001','An external wall',$");
    expect(result).toHaveLength(5);
    expect(result[0]).toBe("'2aG1gNarLHm9Qs6Q3z97P1'");
    expect(result[1]).toBe('#2');
    expect(result[2]).toBe("'Wall-001'");
    expect(result[3]).toBe("'An external wall'");
    expect(result[4]).toBe('$');
  });
});
