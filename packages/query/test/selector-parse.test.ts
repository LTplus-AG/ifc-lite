/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The seventeen worked examples on the IfcOpenShell selector-syntax page, each
 * pinned to the exact AST it must produce (#4091). The page is the spec, so a
 * case here that drifts is a case where ifc-lite stopped reading the same
 * language — the failure mode the issue reported, where a valid selector
 * matched nothing and said nothing.
 *
 * https://docs.ifcopenshell.org/ifcopenshell-python/selector_syntax.html
 */

import { describe, it, expect } from 'vitest';
import { parseSelector } from '../src/selector/parse.js';
import type { SelectorFilter, SelectorParseResult, SelectorQuery } from '../src/selector/ast.js';

const GUID = '325Q7Fhnf67OZC$$r43uzK';
const GUID2 = '2VlJ7nbF5AFfQQuRvSWexT';

function parsed(text: string): SelectorQuery {
  const result = parseSelector(text);
  if (!result.ok) throw new Error(`expected a parse, got: ${result.error.message} @${result.error.offset}`);
  return result.query;
}

function error(text: string): { message: string; offset: number } {
  const result: SelectorParseResult = parseSelector(text);
  if (result.ok) throw new Error(`expected a parse error for ${JSON.stringify(text)}`);
  return result.error;
}

function one(filters: SelectorFilter[]): SelectorQuery {
  return { groups: [{ filters }] };
}

const cls = (name: string, text = name, negate = false): SelectorFilter =>
  ({ kind: 'class', name, negate, text });
const guid = (id: string, text = id, negate = false): SelectorFilter =>
  ({ kind: 'globalId', id, negate, text });

describe('parseSelector — the documented examples', () => {
  it('1. a single class', () => {
    expect(parsed('IfcElement')).toStrictEqual(one([cls('IfcElement')]));
  });

  it('2. two classes chained with a comma', () => {
    expect(parsed('IfcWall, IfcSlab')).toStrictEqual(one([cls('IfcWall'), cls('IfcSlab')]));
  });

  it('3. classes plus a material keyword', () => {
    expect(parsed('IfcWall, IfcSlab, material=concrete')).toStrictEqual(one([
      cls('IfcWall'),
      cls('IfcSlab'),
      { kind: 'material', op: '=', value: { kind: 'string', text: 'concrete' }, text: 'material=concrete' },
    ]));
  });

  it('4. GlobalIds, alone and chained', () => {
    expect(parsed(GUID)).toStrictEqual(one([guid(GUID)]));
    expect(parsed(`${GUID}, ${GUID2}`)).toStrictEqual(one([guid(GUID), guid(GUID2)]));
  });

  it('5. a class minus one GlobalId', () => {
    expect(parsed(`IfcWall, ! ${GUID}`)).toStrictEqual(one([
      cls('IfcWall'),
      guid(GUID, `! ${GUID}`, true),
    ]));
  });

  it('6. a class minus a subclass', () => {
    expect(parsed('IfcElement, ! IfcWall')).toStrictEqual(one([
      cls('IfcElement'),
      cls('IfcWall', '! IfcWall', true),
    ]));
  });

  it('7. an attribute equality', () => {
    expect(parsed('IfcDoor, Name=D01')).toStrictEqual(one([
      cls('IfcDoor'),
      { kind: 'attribute', name: 'Name', op: '=', value: { kind: 'string', text: 'D01' }, text: 'Name=D01' },
    ]));
  });

  it('8. an attribute matched by a regular expression', () => {
    expect(parsed('IfcDoor, Name=/D[0-9]{2}/')).toStrictEqual(one([
      cls('IfcDoor'),
      { kind: 'attribute', name: 'Name', op: '=', value: { kind: 'regex', source: 'D[0-9]{2}' }, text: 'Name=/D[0-9]{2}/' },
    ]));
  });

  it('9. a property in a named property set', () => {
    expect(parsed('IfcWall, Pset_WallCommon.FireRating=2HR')).toStrictEqual(one([
      cls('IfcWall'),
      {
        kind: 'property',
        pset: { kind: 'string', text: 'Pset_WallCommon' },
        prop: { kind: 'string', text: 'FireRating' },
        op: '=',
        value: { kind: 'string', text: '2HR' },
        text: 'Pset_WallCommon.FireRating=2HR',
      },
    ]));
  });

  it('10. four classes and a regex property-set name', () => {
    expect(parsed('IfcWall, IfcColumn, IfcBeam, IfcFooting, /Pset_.*Common/.LoadBearing=TRUE')).toStrictEqual(one([
      cls('IfcWall'),
      cls('IfcColumn'),
      cls('IfcBeam'),
      cls('IfcFooting'),
      {
        kind: 'property',
        pset: { kind: 'regex', source: 'Pset_.*Common' },
        prop: { kind: 'string', text: 'LoadBearing' },
        op: '=',
        value: { kind: 'string', text: 'TRUE' },
        text: '/Pset_.*Common/.LoadBearing=TRUE',
      },
    ]));
  });

  it('11. "is set" spelled as != NULL', () => {
    expect(parsed('IfcElement, /Pset_.*Common/.FireRating != NULL')).toStrictEqual(one([
      cls('IfcElement'),
      {
        kind: 'property',
        pset: { kind: 'regex', source: 'Pset_.*Common' },
        prop: { kind: 'string', text: 'FireRating' },
        op: '!=',
        value: { kind: 'null' },
        text: '/Pset_.*Common/.FireRating != NULL',
      },
    ]));
  });

  it('12. type and a quoted location', () => {
    expect(parsed('IfcWall, type=WT01, location="Level 3"')).toStrictEqual(one([
      cls('IfcWall'),
      { kind: 'type', op: '=', value: { kind: 'string', text: 'WT01' }, text: 'type=WT01' },
      { kind: 'location', op: '=', value: { kind: 'string', text: 'Level 3' }, text: 'location="Level 3"' },
    ]));
  });

  it('13. a classification matched by a regular expression', () => {
    expect(parsed('IfcElement, classification=/Pr_.*/')).toStrictEqual(one([
      cls('IfcElement'),
      { kind: 'classification', op: '=', value: { kind: 'regex', source: 'Pr_.*' }, text: 'classification=/Pr_.*/' },
    ]));
  });

  it('14. classes, a subtraction, a material and a regex property', () => {
    const text = `IfcWall, IfcSlab, ! ${GUID}, material=concrete, /Pset_.*Common/.FireRating=2HR`;
    expect(parsed(text)).toStrictEqual(one([
      cls('IfcWall'),
      cls('IfcSlab'),
      guid(GUID, `! ${GUID}`, true),
      { kind: 'material', op: '=', value: { kind: 'string', text: 'concrete' }, text: 'material=concrete' },
      {
        kind: 'property',
        pset: { kind: 'regex', source: 'Pset_.*Common' },
        prop: { kind: 'string', text: 'FireRating' },
        op: '=',
        value: { kind: 'string', text: '2HR' },
        text: '/Pset_.*Common/.FireRating=2HR',
      },
    ]));
  });

  it('15. two groups unioned with +', () => {
    expect(parsed('IfcSlab, material=concrete + IfcDoor')).toStrictEqual({
      groups: [
        {
          filters: [
            cls('IfcSlab'),
            { kind: 'material', op: '=', value: { kind: 'string', text: 'concrete' }, text: 'material=concrete' },
          ],
        },
        { filters: [cls('IfcDoor')] },
      ],
    });
  });

  it('16. three groups unioned with +', () => {
    expect(parsed(`IfcDoor, IfcWindow + IfcWall, IfcSlab, material=concrete + ${GUID}`)).toStrictEqual({
      groups: [
        { filters: [cls('IfcDoor'), cls('IfcWindow')] },
        {
          filters: [
            cls('IfcWall'),
            cls('IfcSlab'),
            { kind: 'material', op: '=', value: { kind: 'string', text: 'concrete' }, text: 'material=concrete' },
          ],
        },
        { filters: [guid(GUID)] },
      ],
    });
  });

  it('17. a class inside a named location', () => {
    expect(parsed('IfcPump, location="Level 3"')).toStrictEqual(one([
      cls('IfcPump'),
      { kind: 'location', op: '=', value: { kind: 'string', text: 'Level 3' }, text: 'location="Level 3"' },
    ]));
  });
});

describe('parseSelector — lexical detail', () => {
  it('unescapes \\" and \\\\ inside a quoted value', () => {
    expect(parsed('Name="foo \\"bar\\" baz"').groups[0]?.filters[0]).toStrictEqual({
      kind: 'attribute',
      name: 'Name',
      op: '=',
      value: { kind: 'string', text: 'foo "bar" baz' },
      text: 'Name="foo \\"bar\\" baz"',
    });
  });

  it('a slash inside quotes is data, not a regular expression', () => {
    expect(parsed('Name="a/b"').groups[0]?.filters[0]).toStrictEqual({
      kind: 'attribute',
      name: 'Name',
      op: '=',
      value: { kind: 'string', text: 'a/b' },
      text: 'Name="a/b"',
    });
  });

  it('an escaped slash inside a regular expression stays in the source', () => {
    expect(parsed('Name=/a\\/b/').groups[0]?.filters[0]).toStrictEqual({
      kind: 'attribute',
      name: 'Name',
      op: '=',
      value: { kind: 'regex', source: 'a/b' },
      text: 'Name=/a\\/b/',
    });
  });

  it('a quoted property-set name carries spaces', () => {
    expect(parsed('"My Set".SomeProp=1').groups[0]?.filters[0]).toStrictEqual({
      kind: 'property',
      pset: { kind: 'string', text: 'My Set' },
      prop: { kind: 'string', text: 'SomeProp' },
      op: '=',
      value: { kind: 'string', text: '1' },
      text: '"My Set".SomeProp=1',
    });
  });

  it('a decimal value stays one word, the leading dot is a separator', () => {
    expect(parsed('Qto_WallBaseQuantities.NetVolume>1.5').groups[0]?.filters[0]).toStrictEqual({
      kind: 'property',
      pset: { kind: 'string', text: 'Qto_WallBaseQuantities' },
      prop: { kind: 'string', text: 'NetVolume' },
      op: '>',
      value: { kind: 'string', text: '1.5' },
      text: 'Qto_WallBaseQuantities.NetVolume>1.5',
    });
  });

  it('*= and !*= win over = and !=', () => {
    expect(parsed('Name*=Wand, Name!*=Fenster').groups[0]?.filters).toStrictEqual([
      { kind: 'attribute', name: 'Name', op: '*=', value: { kind: 'string', text: 'Wand' }, text: 'Name*=Wand' },
      { kind: 'attribute', name: 'Name', op: '!*=', value: { kind: 'string', text: 'Fenster' }, text: 'Name!*=Fenster' },
    ]);
  });

  it('every comparison operator lexes', () => {
    for (const op of ['=', '!=', '>', '>=', '<', '<='] as const) {
      expect(parsed(`Pset.Prop${op}1`).groups[0]?.filters[0]).toMatchObject({ kind: 'property', op });
    }
  });

  it('NULL is a null literal in any case, but "NULL" quoted is a string', () => {
    expect(parsed('Pset.Prop=NULL').groups[0]?.filters[0]).toMatchObject({ value: { kind: 'null' } });
    expect(parsed('Pset.Prop=null').groups[0]?.filters[0]).toMatchObject({ value: { kind: 'null' } });
    expect(parsed('Pset.Prop="NULL"').groups[0]?.filters[0]).toMatchObject({
      value: { kind: 'string', text: 'NULL' },
    });
  });

  it('TRUE and FALSE stay strings — the adapter decides how to compare them', () => {
    expect(parsed('Pset.LoadBearing=TRUE').groups[0]?.filters[0]).toMatchObject({
      value: { kind: 'string', text: 'TRUE' },
    });
  });

  it('a query: key path keeps its dots', () => {
    expect(parsed('query:types.count=0').groups[0]?.filters[0]).toStrictEqual({
      kind: 'query',
      keys: 'types.count',
      op: '=',
      value: { kind: 'string', text: '0' },
      text: 'query:types.count=0',
    });
  });
});

describe('parseSelector — errors name the offset', () => {
  it('a trailing * is rejected instead of matching nothing (#4091)', () => {
    const err = error('IfcWall*');
    expect(err.offset).toBe(7);
    expect(err.message).toContain('*=');
  });

  it('an unknown bare word points at the word', () => {
    const err = error('IfcWall, Wand');
    expect(err.offset).toBe(9);
    expect(err.message).toContain('"Wand"');
  });

  it('empty input', () => {
    expect(error('')).toStrictEqual({ message: 'empty selector: type a class name such as IfcWall', offset: 0 });
    expect(error('   ').offset).toBe(0);
  });

  it('a trailing comma', () => {
    expect(error('IfcWall,').offset).toBe(8);
  });

  it('an empty group either side of +', () => {
    expect(error('IfcWall +').offset).toBe(9);
    expect(error('+ IfcWall').offset).toBe(0);
  });

  it('an unterminated quote or regular expression', () => {
    expect(error('Name="abc').message).toContain('unterminated quoted value');
    expect(error('Name=/abc').message).toContain('unterminated regular expression');
  });

  it('"!" cannot negate a comparison', () => {
    const err = error('IfcWall, !Name=D01');
    expect(err.offset).toBe(9);
    expect(err.message).toContain('may only negate');
  });

  it('a missing value after an operator', () => {
    expect(error('Name=').offset).toBe(5);
    expect(error('Name=, IfcWall').offset).toBe(5);
  });

  it('a missing operator after a property name', () => {
    expect(error('Pset_WallCommon.FireRating').message).toContain('operators');
  });

  it('a regular expression on its own is not a filter', () => {
    expect(error('/D[0-9]{2}/').message).toContain('needs an attribute or property');
  });

  it('an empty regular expression', () => {
    expect(error('Name=//').message).toContain('empty regular expression');
  });
});
