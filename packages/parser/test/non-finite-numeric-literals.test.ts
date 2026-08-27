/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A STEP real literal whose exponent overflows the IEEE-754 double range
 * (`1.0E400`) parses to `Infinity`, and `isNaN(Infinity)` is `false` — so the
 * old `if (!isNaN(num)) return num;` guard admitted it. From there the value
 * entered the property table and reached every writer, where `JSON.stringify`
 * silently turns it into `null`.
 *
 * `NaN` and `Infinity` are asserted SEPARATELY throughout: they behave
 * differently under the guard, and a `Number.isFinite` -> `isNaN` mutation
 * fails only the infinite cases.
 */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { EntityExtractor } from '../src/entity-extractor.js';
import { ColumnarParser, extractPropertiesOnDemand } from '../src/columnar-parser.js';
import { getNumber, getReference } from '../src/attribute-helpers.js';

/** Parse one STEP record through the real extractor and return its attributes. */
function attributesOf(record: string): unknown[] {
  const source = new TextEncoder().encode(record);
  const tokenizer = new StepTokenizer(source);
  const refs = [...tokenizer.scanEntitiesFast()];
  expect(refs).toHaveLength(1); // anti-vacuity: the fixture really tokenized
  const extractor = new EntityExtractor(source);
  const entity = extractor.extractEntity({
    expressId: refs[0].expressId,
    type: refs[0].type,
    byteOffset: refs[0].offset,
    byteLength: refs[0].length,
    lineNumber: refs[0].line,
  });
  expect(entity).not.toBeNull();
  return entity!.attributes;
}

describe('entity-extractor rejects non-finite numeric literals', () => {
  it('still parses ordinary finite reals unchanged (negative control)', () => {
    const attrs = attributesOf(`#1=IFCCARTESIANPOINT((2.5,-2.5,0.));`);
    expect(attrs).toEqual([[2.5, -2.5, 0]]);
  });

  it('still parses the largest representable double unchanged (negative control)', () => {
    const attrs = attributesOf(`#1=IFCCARTESIANPOINT((1.0E308,-1.0E308,1.0E-308));`);
    const coords = attrs[0] as number[];
    expect(coords.every((c) => typeof c === 'number' && Number.isFinite(c))).toBe(true);
    expect(coords[0]).toBe(1.0e308);
    expect(coords[1]).toBe(-1.0e308);
  });

  it('does not admit Infinity from an overflowing positive exponent', () => {
    const attrs = attributesOf(`#1=IFCCARTESIANPOINT((1.0E400,0.,0.));`);
    const coords = attrs[0] as unknown[];
    expect(coords[0]).not.toBe(Infinity);
    // The literal is preserved verbatim rather than dropped or clamped.
    expect(coords[0]).toBe('1.0E400');
    expect(coords[2]).toBe(0);
  });

  it('does not admit -Infinity from an overflowing negative literal', () => {
    const attrs = attributesOf(`#1=IFCCARTESIANPOINT((-1.0E400,0.,0.));`);
    const coords = attrs[0] as unknown[];
    expect(coords[0]).not.toBe(-Infinity);
    expect(coords[0]).toBe('-1.0E400');
  });

  it('does not admit NaN from a bare NaN token', () => {
    const attrs = attributesOf(`#1=IFCCARTESIANPOINT((NaN,0.,0.));`);
    const coords = attrs[0] as unknown[];
    expect(typeof coords[0]).toBe('string');
    expect(Number.isNaN(coords[0] as number)).toBe(false);
  });

  it('rejects an express-id reference whose digits overflow to Infinity', () => {
    const huge = '1'.repeat(400);
    // Anti-vacuity: this really is the overflowing shape.
    expect(parseInt(huge, 10)).toBe(Infinity);
    const attrs = attributesOf(`#1=IFCRELAGGREGATES('g',$,$,$,#${huge},(#2));`);
    expect(attrs[4]).toBeNull();
    // Negative control: an ordinary reference still resolves.
    expect(attributesOf(`#1=IFCRELAGGREGATES('g',$,$,$,#42,(#2));`)[4]).toBe(42);
  });
});

describe('attribute-helpers reject non-finite numeric strings', () => {
  it('getNumber keeps finite values (negative control)', () => {
    expect(getNumber('2.5')).toBe(2.5);
    expect(getNumber('-2.5')).toBe(-2.5);
    expect(getNumber(2.5)).toBe(2.5);
  });

  it('getNumber rejects Infinity', () => {
    expect(getNumber('1.0E400')).toBeUndefined();
  });

  it('getNumber rejects -Infinity', () => {
    expect(getNumber('-1.0E400')).toBeUndefined();
  });

  it('getNumber rejects NaN', () => {
    expect(getNumber('not-a-number')).toBeUndefined();
  });

  it('getReference rejects an overflowing express id', () => {
    expect(getReference('#42')).toBe(42); // negative control
    expect(getReference(`#${'1'.repeat(400)}`)).toBeUndefined();
  });
});

describe('non-finite literals never reach the property table', () => {
  it('keeps the finite property and refuses the overflowing ones', async () => {
    const ifc = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#20=IFCPROPERTYSINGLEVALUE('Overflow',$,IFCREAL(1.0E400),$);
#21=IFCPROPERTYSINGLEVALUE('NegOverflow',$,IFCREAL(-1.0E400),$);
#22=IFCPROPERTYSINGLEVALUE('Finite',$,IFCREAL(2.5),$);
#30=IFCPROPERTYSET('pset-guid',#1,'Pset_Test',$,(#20,#21,#22));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#30);`;

    const source = new TextEncoder().encode(ifc);
    const tokenizer = new StepTokenizer(source);
    const entityRefs = [...tokenizer.scanEntitiesFast()].map((ref) => ({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    }));

    const parser = new ColumnarParser();
    const store = await parser.parseLite(source.buffer.slice(0), entityRefs, {});
    const psets = extractPropertiesOnDemand(store, 10);

    // Anti-vacuity: the pset really was extracted with all three properties.
    expect(psets).toHaveLength(1);
    expect(psets[0].properties.map((p) => p.name)).toEqual([
      'Overflow',
      'NegOverflow',
      'Finite',
    ]);

    const byName = new Map(psets[0].properties.map((p) => [p.name, p.value]));
    expect(byName.get('Finite')).toBe(2.5); // negative control
    expect(byName.get('Overflow')).not.toBe(Infinity);
    expect(byName.get('NegOverflow')).not.toBe(-Infinity);

    for (const prop of psets[0].properties) {
      if (typeof prop.value === 'number') {
        expect(Number.isFinite(prop.value)).toBe(true);
      }
    }
  });
});
