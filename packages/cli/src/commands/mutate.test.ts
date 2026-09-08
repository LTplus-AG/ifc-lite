/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  parseWhereFilter,
  parseSetArg,
  coerceValue,
  matchesFilter,
  splitStepArgs,
  applyAttributeMutations,
  entitiesWithObjectType,
} from './mutate.js';
import { PropertyValueType } from '@ifc-lite/data';

describe('parseWhereFilter', () => {
  it.each([
    ['equals', 'Pset_WallCommon.IsExternal=true', { psetName: 'Pset_WallCommon', propName: 'IsExternal', operator: '=', value: 'true' }],
    ['not-equals', 'Pset_WallCommon.IsExternal!=true', { psetName: 'Pset_WallCommon', propName: 'IsExternal', operator: '!=', value: 'true' }],
    ['greater-than', 'Qto_WallBaseQuantities.Height>2.5', { psetName: 'Qto_WallBaseQuantities', propName: 'Height', operator: '>', value: '2.5' }],
    ['less-than', 'Qto_SlabBaseQuantities.Width<1', { psetName: 'Qto_SlabBaseQuantities', propName: 'Width', operator: '<', value: '1' }],
    ['greater-or-equal', 'CustomPset.Value>=100', { psetName: 'CustomPset', propName: 'Value', operator: '>=', value: '100' }],
    ['less-or-equal', 'CustomPset.Value<=50', { psetName: 'CustomPset', propName: 'Value', operator: '<=', value: '50' }],
    ['contains (tilde)', 'Pset_WallCommon.Reference~concrete', { psetName: 'Pset_WallCommon', propName: 'Reference', operator: 'contains', value: 'concrete' }],
    ['exists (no operator)', 'Pset_WallCommon.IsExternal', { psetName: 'Pset_WallCommon', propName: 'IsExternal', operator: 'exists' }],
  ])('parses %s filter: %s', (_label, input, expected) => {
    expect(parseWhereFilter(input)).toEqual(expected);
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

  it('treats an operator at the very start of the prop segment as no match (empty propName is not a valid filter)', () => {
    // rest = "=value": the '=' sits at index 0, which the opIdx > 0 guard
    // deliberately excludes so filters can't resolve to an empty propName.
    // It falls through to the exists-only shape instead of matching '='.
    const result = parseWhereFilter('Pset.=value');
    expect(result.operator).toBe('exists');
    expect(result.propName).toBe('=value');
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

  it('treats a leading dot (dotIdx === 0) as attribute mutation, same as no dot at all', () => {
    // dotIdx <= 0 covers both "no dot" (-1) and "dot at position 0". A
    // leading dot with nothing before it can't be a real pset name, so this
    // is parsed as an attribute mutation named ".Name" rather than a
    // pset.prop split with an empty psetName.
    const result = parseSetArg('.Name=value');
    expect(result.isAttribute).toBe(true);
    expect(result.psetName).toBeNull();
    expect(result.propName).toBe('.Name');
    expect(result.value).toBe('value');
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

describe('applyAttributeMutations', () => {
  /** A minimal STEP body with one entity line of the given type. */
  const stepFile = (expressId: number, type: string, args: string): string =>
    ['ISO-10303-21;', 'DATA;', `#${expressId}=${type}(${args});`, 'ENDSEC;'].join('\n');

  const mutation = (expressId: number, propName: string, value: string) => ({
    entity: { ref: { expressId } },
    propName,
    value,
  });

  /** The arguments of the single entity line, after mutation. */
  const argsOf = (content: string): string[] => {
    const line = content.split('\n').find((l) => l.startsWith('#'))!;
    return splitStepArgs(line.slice(line.indexOf('(') + 1, line.lastIndexOf(')')));
  };

  // IfcRoot fixes GlobalId(0), OwnerHistory(1), Name(2), Description(3), and
  // IfcObject adds ObjectType(4). Those positions come from the schema, not
  // from us, and this writer edits STEP text BY INDEX — so an off-by-one
  // silently rewrites a different attribute instead of failing. Nothing
  // asserted them before.
  let objectTypeEntities: ReadonlySet<string>;
  beforeAll(async () => {
    objectTypeEntities = await entitiesWithObjectType('IFC4');
  });

  it('writes Name into slot 2, leaving its neighbours untouched', () => {
    const before = stepFile(1, 'IFCWALL', "'guid',$,'Old',$,$,$,$,$,$");
    const args = argsOf(applyAttributeMutations(before, [mutation(1, 'Name', 'New')], objectTypeEntities));
    expect(args[2]).toBe("'New'");
    expect(args[0]).toBe("'guid'"); // GlobalId must not move
    expect(args[3]).toBe('$'); // Description must not be clobbered
  });

  it('writes Description into slot 3 and ObjectType into slot 4', () => {
    const before = stepFile(1, 'IFCWALL', "'guid',$,'Name',$,$,$,$,$,$");
    const withDesc = applyAttributeMutations(before, [mutation(1, 'Description', 'D')], objectTypeEntities);
    expect(argsOf(withDesc)[3]).toBe("'D'");
    expect(argsOf(withDesc)[2]).toBe("'Name'");

    const withType = applyAttributeMutations(before, [mutation(1, 'ObjectType', 'T')], objectTypeEntities);
    expect(argsOf(withType)[4]).toBe("'T'");
    expect(argsOf(withType)[3]).toBe('$');
  });

  it('applies ObjectType to entities the old hand-written list omitted', () => {
    // IfcFurniture declares ObjectType, but was not among the 29 names the
    // previous allowlist happened to contain, so this was refused outright
    // with a "not applicable" warning. 189 of IFC4's 218 such entities sat
    // in that position.
    const before = stepFile(7, 'IFCFURNITURE', "'guid',$,'Desk',$,$,$,$,$,$");
    const args = argsOf(
      applyAttributeMutations(before, [mutation(7, 'ObjectType', 'Workstation')], objectTypeEntities),
    );
    expect(args[4]).toBe("'Workstation'");
  });

  it('still refuses ObjectType on entities that genuinely lack it', () => {
    // The other direction of the same rule, and the one worth guarding: the
    // fix must not become "write it anywhere". A relationship and a type
    // object have no ObjectType slot, so slot 4 there is a different
    // attribute entirely and writing to it would corrupt the file.
    for (const type of ['IFCRELAGGREGATES', 'IFCWALLTYPE', 'IFCPROPERTYSET']) {
      expect(objectTypeEntities.has(type), `${type} must not be treated as having ObjectType`).toBe(false);
      const before = stepFile(3, type, "'guid',$,'N',$,$,$,$,$,$");
      const after = applyAttributeMutations(before, [mutation(3, 'ObjectType', 'X')], objectTypeEntities);
      expect(argsOf(after)[4], `${type} slot 4 must be untouched`).toBe('$');
    }
  });

  it('leaves an unrecognised attribute name alone', () => {
    const before = stepFile(1, 'IFCWALL', "'guid',$,'Name',$,$,$,$,$,$");
    const after = applyAttributeMutations(before, [mutation(1, 'NotAnAttribute', 'X')], objectTypeEntities);
    expect(after).toBe(before);
  });

  it('escapes quotes and backslashes so a value cannot break out of the STEP string', () => {
    const before = stepFile(1, 'IFCWALL', "'guid',$,'Name',$,$,$,$,$,$");
    const args = argsOf(
      applyAttributeMutations(before, [mutation(1, 'Name', "O'Brien\\x")], objectTypeEntities),
    );
    expect(args[2]).toBe("'O''Brien\\\\x'");
  });
});

describe('entitiesWithObjectType', () => {
  it('reads the bundled schema rather than a hand-kept list', async () => {
    // The size is the point: a hand-written list drifts behind the schema,
    // a derived one cannot.
    const ifc4 = await entitiesWithObjectType('IFC4');
    expect(ifc4.size).toBeGreaterThan(100);
    expect(ifc4.has('IFCFURNITURE')).toBe(true);
    expect(ifc4.has('IFCWALL')).toBe(true);
    expect(ifc4.has('IFCRELAGGREGATES')).toBe(false);
  });

  it('falls back to IFC4 for a schema version it has no table for', async () => {
    // StepExporter accepts 'IFC5', which has no attribute table here.
    // Throwing would break `mutate` outright on such a file; falling back
    // preserves the old hand-written list's behaviour, which was schema-blind.
    const ifc5 = await entitiesWithObjectType('IFC5');
    expect(ifc5.has('IFCWALL')).toBe(true);
  });
});
