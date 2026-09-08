/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  parseWhereFilter,
  parseSetArg,
  coerceValue,
  matchesFilter,
  applyAttributeMutations,
  entitiesWithObjectType,
} from './mutate.js';
import { splitTopLevelStepArgs } from './step-args.js';
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
    return splitTopLevelStepArgs(line.slice(line.indexOf('(') + 1, line.lastIndexOf(')')))!;
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

  // ---- #4125: a record this pass cannot read is refused, not rewritten ----

  it('refuses the record whose undoubled apostrophes made a 9-attribute wall into 4', () => {
    // Reproduced against the real command before the fix: exit 0, "Mutated 1
    // entities", and the output line was
    //   #2=IFCWALL('1BBBBBBBBBBBBBBBBBBBBB',$,'NewName',.NOTDEFINED.);
    // with Description, ObjectType, ObjectPlacement, Representation and Tag
    // gone. `step-args.ts`'s header has the walk-through.
    const before = stepFile(2, 'IFCWALL', "'1BBBBBBBBBBBBBBBBBBBBB',$,'John's wall',$,$,$,$,'A's',.NOTDEFINED.");
    expect(() =>
      applyAttributeMutations(before, [mutation(2, 'Name', 'NewName')], objectTypeEntities),
    ).toThrow(/could not be read as a complete argument list/);
  });

  it('refuses the same wall when the apostrophes sit inside typed values', () => {
    // Reproduced against the real command built from the FIRST fix for #4125,
    // which checked only the top level: exit 0, "Mutated 1 entities", and
    //   #2=IFCWALL('1BBBBBBBBBBBBBBBBBBBBB',$,'NewName',$,$,'T',.NOTDEFINED.);
    // Nine attributes down to seven. The phantom string swallows
    // `),$,IFCLABEL(`, one `)` and one `(`, so the depth still balances and
    // each part is a keyword applied to one list.
    const before = stepFile(
      2,
      'IFCWALL',
      "'1BBBBBBBBBBBBBBBBBBBBB',$,IFCLABEL('a's'),$,IFCLABEL('b's'),$,$,'T',.NOTDEFINED.",
    );
    expect(() =>
      applyAttributeMutations(before, [mutation(2, 'Name', 'NewName')], objectTypeEntities),
    ).toThrow(/#2=IFCWALL/);
  });

  it('refuses a record carrying a STEP block comment, the cause the error names', () => {
    // Reproduced against the built CLI at the first fix for #4125: a comment
    // with no whitespace in it broke no bare run, so it was accepted as a
    // phantom slot and `--set Description` landed on Name.
    //   $ ifc-lite mutate cmt2.ifc --id 2 --set Description=NEWDESC --out outE.ifc
    //   Mutated 1 entities: Description = NEWDESC        # exit 0
    //   #2=IFCWALL('1BBB...',/*edited*/,$,'NEWDESC','MyDescription',$,$,$,$,.NOTDEFINED.);
    // Name overwritten, Description untouched. "a comment inside the argument
    // list" is listed as a usual cause in the error below, so it is pinned.
    const before = stepFile(
      2,
      'IFCWALL',
      "'1BBBBBBBBBBBBBBBBBBBBB',/*edited*/,$,'MyName','MyDescription',$,$,$,$,.NOTDEFINED.",
    );
    expect(() =>
      applyAttributeMutations(before, [mutation(2, 'Description', 'NEWDESC')], objectTypeEntities),
    ).toThrow(/a comment inside the argument list/);
  });

  it('still rewrites a record whose Name contains a slash', () => {
    // The false-positive control for the test above. `/` is what refuses a
    // comment, and storey and family names carry slashes constantly, so a
    // scanner that refused these would break `mutate` on ordinary files.
    const before = stepFile(1, 'IFCWALL', "'guid',$,'Level 1/2',$,$,$,$,$,$");
    const args = argsOf(applyAttributeMutations(before, [mutation(1, 'Name', 'A/B')], objectTypeEntities));
    expect(args[2]).toBe("'A/B'");
    expect(args[3]).toBe('$');
  });

  it('names the refused record, so the error says which one', () => {
    const before = stepFile(2, 'IFCWALL', "'guid',$,'John's wall',$,$,$,$,'A's',$");
    expect(() =>
      applyAttributeMutations(before, [mutation(2, 'Name', 'X')], objectTypeEntities),
    ).toThrow(/#2=IFCWALL/);
  });

  it.each([
    ['an unterminated string', "'guid',$,'never closed"],
    ['a stray closing paren', "'guid',$,'N'),$,$,$,$,$"],
    ['an unclosed nested list', "'guid',$,'N',(1,2,$,$,$,$"],
    // IfcPerson declares MiddleNames and PrefixTitles as adjacent lists of
    // strings, so one undoubled apostrophe in each reads eight attributes as
    // seven with the parens still balanced.
    ['undoubled apostrophes in two adjacent string lists', "'id','Smith','John',('D'Arcy'),('O'Neill'),$,$,$"],
  ])('refuses a record with %s', (_label, args) => {
    const before = stepFile(4, 'IFCWALL', args);
    expect(() =>
      applyAttributeMutations(before, [mutation(4, 'Name', 'X')], objectTypeEntities),
    ).toThrow(/refusing to rewrite 1 record/);
  });

  it('refuses a record that does not close on its own line instead of reporting a mutation it never made', () => {
    // The exporter re-emits source lines verbatim, so a wrapped record from the
    // input file arrives here split across two array entries. Measured against
    // the real command before the fix: exit 0, "Mutated 1 entities: Name =
    // NewName", and the wall's Name still 'Old' in the output file.
    const before = [
      'ISO-10303-21;',
      'DATA;',
      "#2=IFCWALL('guid',$,'Old',$,$,",
      '$,$,$,$);',
      'ENDSEC;',
    ].join('\n');
    expect(() =>
      applyAttributeMutations(before, [mutation(2, 'Name', 'NewName')], objectTypeEntities),
    ).toThrow(/#2=IFCWALL/);
  });

  it('refuses a wrapped record whose first line happens to close a nested list', () => {
    // `lastIndexOf(')')` finds the `)` of the (#3,#4) set, so this line looks
    // complete to a scan that only hunts for a closing paren.
    const before = [
      'DATA;',
      "#5=IFCRELDEFINESBYPROPERTIES('guid',$,'Old',$,(#3,#4),",
      '#6);',
    ].join('\n');
    expect(() =>
      applyAttributeMutations(before, [mutation(5, 'Name', 'NewName')], objectTypeEntities),
    ).toThrow(/#5=IFCRELDEFINESBYPROPERTIES/);
  });

  it('collects every unreadable record into one error', () => {
    const before = [
      'DATA;',
      "#2=IFCWALL('guid',$,'John's wall',$,$,$,$,'A's',$);",
      "#3=IFCWALL('guid3',$,'N'),$,$,$,$,$,$);",
      'ENDSEC;',
    ].join('\n');
    expect(() =>
      applyAttributeMutations(
        before,
        [mutation(2, 'Name', 'X'), mutation(3, 'Name', 'X')],
        objectTypeEntities,
      ),
    ).toThrow(/refusing to rewrite 2 record\(s\).*#2=IFCWALL, #3=IFCWALL/s);
  });

  it('leaves an unreadable record that was NOT targeted alone', () => {
    // The refusal is scoped to records this run was asked to rewrite. A
    // malformed line elsewhere in the file is not this command's business.
    const before = [
      'DATA;',
      "#2=IFCWALL('guid',$,'Old',$,$,$,$,$,$);",
      "#9=IFCWALL('other',$,'Bob's wall',$,$,$,$,'C's',$);",
      'ENDSEC;',
    ].join('\n');
    const after = applyAttributeMutations(before, [mutation(2, 'Name', 'New')], objectTypeEntities);
    expect(after.split('\n')[2]).toBe(before.split('\n')[2]);
    expect(after.split('\n')[1]).toContain("'New'");
  });

  it('rewrites a well-formed record with a # and a comma inside its Name, byte-for-byte elsewhere', () => {
    const before = stepFile(1, 'IFCWALL', "'guid',#2,'Wall #3, north','Desc',$,#4,$,'TAG',.NOTDEFINED.");
    const after = applyAttributeMutations(before, [mutation(1, 'Name', 'Renamed')], objectTypeEntities);
    expect(after).toBe(stepFile(1, 'IFCWALL', "'guid',#2,'Renamed','Desc',$,#4,$,'TAG',.NOTDEFINED."));
  });

  it('rewrites through doubled-quote escapes and a nested list without touching them', () => {
    const before = stepFile(1, 'IFCWALL', "'guid',$,'it''s',(1.,2.,3.),$,$,$,'T''AG',$");
    const after = applyAttributeMutations(before, [mutation(1, 'Name', 'New')], objectTypeEntities);
    expect(after).toBe(stepFile(1, 'IFCWALL', "'guid',$,'New',(1.,2.,3.),$,$,$,'T''AG',$"));
  });

  it('leaves a record it was not asked to change byte-identical', () => {
    const before = [
      'ISO-10303-21;',
      'DATA;',
      "#1=IFCWALL('guid',$,'Keep me',$,$,$,$,'TAG',.NOTDEFINED.);",
      "#2=IFCWALL('guid2', $ , 'Rename me' ,$,$,$,$,$,$);",
      'ENDSEC;',
    ].join('\n');
    const after = applyAttributeMutations(before, [mutation(2, 'Name', 'New')], objectTypeEntities);
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    expect(afterLines[2]).toBe(beforeLines[2]);
    // and the rewritten one keeps every byte of its other slots, padding included
    expect(afterLines[3]).toBe("#2=IFCWALL('guid2', $ ,'New',$,$,$,$,$,$);");
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
