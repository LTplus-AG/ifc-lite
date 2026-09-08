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
import {
  ColumnarParser,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractGeoreferencingOnDemand,
} from '../src/columnar-parser.js';
import { getNumber, getReference } from '../src/attribute-helpers.js';
import { readRefId } from '../src/columnar-parser-attributes.js';

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

/* ------------------------------------------------------------------ *
 * A non-finite literal must not become a PLAUSIBLE value either.
 *
 * Preserving `1.0E400` as the string `"1.0E400"` is right where the value type
 * is a union that admits strings (the property table). Where the consumer's
 * field is typed `number`, the preserved string fails the `typeof x ===
 * 'number'` test, and the fallback substituted `0` — turning a detectably
 * missing value into an undetectably wrong one. A null easting is visibly
 * absent; an easting of `0` is a coordinate.
 * ------------------------------------------------------------------ */

/** Parse a whole STEP body through `parseLite` and hand back the store. */
async function storeOf(ifc: string) {
  const source = new TextEncoder().encode(ifc);
  const refs = [...new StepTokenizer(source).scanEntitiesFast()].map((r) => ({
    expressId: r.expressId,
    type: r.type,
    byteOffset: r.offset,
    byteLength: r.length,
    lineNumber: r.line,
  }));
  return await new ColumnarParser().parseLite(source.buffer.slice(0), refs, {});
}

const OWNER = `#1=IFCOWNERHISTORY($,$,$,$,$,$,$,0);`;

function quantityFile(overflowLiteral: string): string {
  return `${OWNER}
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#20=IFCQUANTITYLENGTH('Overflow',$,$,${overflowLiteral},$);
#21=IFCQUANTITYLENGTH('Finite',$,$,2.5,$);
#30=IFCELEMENTQUANTITY('qset-guid',#1,'Qto_Test',$,$,(#20,#21));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#30);`;
}

describe('quantities do not substitute 0 for an unrepresentable measure', () => {
  it('keeps every finite quantity (negative control / anti-vacuity)', async () => {
    const store = await storeOf(`${OWNER}
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#20=IFCQUANTITYLENGTH('AlsoFinite',$,$,7.25,$);
#21=IFCQUANTITYLENGTH('Finite',$,$,2.5,$);
#30=IFCELEMENTQUANTITY('qset-guid',#1,'Qto_Test',$,$,(#20,#21));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#30);`);
    const qsets = extractQuantitiesOnDemand(store, 10);
    // Anti-vacuity: the fixture really produces a quantity set with BOTH
    // entries, so a later assertion that one is missing means something.
    expect(qsets).toHaveLength(1);
    expect(qsets[0].quantities.map((q) => q.name)).toEqual(['AlsoFinite', 'Finite']);
    expect(qsets[0].quantities.map((q) => q.value)).toEqual([7.25, 2.5]);
  });

  it.each([
    ['+Infinity', '1.0E400'],
    ['-Infinity', '-1.0E400'],
  ])('drops the %s quantity instead of reporting it as 0', async (_label, literal) => {
    const qsets = extractQuantitiesOnDemand(await storeOf(quantityFile(literal)), 10);

    // Anti-vacuity: the quantity set still exists and still carries the finite
    // sibling — the overflowing entry is what went, not the whole set.
    expect(qsets).toHaveLength(1);
    const byName = new Map(qsets[0].quantities.map((q) => [q.name, q.value]));
    expect(byName.get('Finite')).toBe(2.5);

    // The point of the fix: absent, not zero. `0` would read as a measurement.
    expect(byName.has('Overflow')).toBe(false);
    expect(byName.get('Overflow')).not.toBe(0);
    for (const q of qsets[0].quantities) expect(Number.isFinite(q.value)).toBe(true);
  });

  it('keeps a genuine zero quantity — absence must mean unrepresentable', async () => {
    // The other direction: dropping is reserved for values the double range
    // cannot hold, and a real 0.0 measure is perfectly representable.
    const store = await storeOf(`${OWNER}
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#20=IFCQUANTITYLENGTH('GenuinelyZero',$,$,0.,$);
#30=IFCELEMENTQUANTITY('qset-guid',#1,'Qto_Test',$,$,(#20));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#30);`);
    const qsets = extractQuantitiesOnDemand(store, 10);
    expect(qsets[0].quantities).toEqual([
      expect.objectContaining({ name: 'GenuinelyZero', value: 0 }),
    ]);
  });
});

function georefFile(e: string, n: string, h: string): string {
  return `${OWNER}
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,$,$);
#6=IFCPROJECTEDCRS('EPSG:2056','CH1903+','CH1903+',$,$,$,$);
#7=IFCMAPCONVERSION(#5,#6,${e},${n},${h},1.,0.,1.);`;
}

describe('georeferencing does not substitute a 0 origin', () => {
  it('reads a fully finite map conversion (negative control / anti-vacuity)', async () => {
    const geo = extractGeoreferencingOnDemand(
      await storeOf(georefFile('2600000.', '1200000.', '400.')),
    );
    // Anti-vacuity: this fixture really does produce a usable georeference, so
    // `mapConversion` being undefined below is caused by the literal.
    expect(geo?.mapConversion).toBeDefined();
    expect(geo!.mapConversion!.eastings).toBe(2600000);
    expect(geo!.mapConversion!.northings).toBe(1200000);
    expect(geo!.mapConversion!.orthogonalHeight).toBe(400);
    expect(geo!.transformMatrix).toBeDefined();
    expect(geo!.transformMatrix!.every((v) => Number.isFinite(v))).toBe(true);
  });

  it.each([
    ['Eastings', '+Infinity', '1.0E400', '1200000.', '400.'],
    ['Eastings', '-Infinity', '-1.0E400', '1200000.', '400.'],
    ['Northings', '+Infinity', '2600000.', '1.0E400', '400.'],
    ['Northings', '-Infinity', '2600000.', '-1.0E400', '400.'],
    ['OrthogonalHeight', '+Infinity', '2600000.', '1200000.', '1.0E400'],
    ['OrthogonalHeight', '-Infinity', '2600000.', '1200000.', '-1.0E400'],
  ])('refuses the map conversion when %s is %s', async (_slot, _sign, e, n, h) => {
    const geo = extractGeoreferencingOnDemand(await storeOf(georefFile(e, n, h)));

    // Absent, not zero: a 0 easting places the model at the projection origin,
    // which is a plausible coordinate and therefore undetectable.
    expect(geo?.mapConversion).toBeUndefined();
    // No transform either — a matrix built from a substituted origin would
    // move every element in the file.
    expect(geo?.transformMatrix).toBeUndefined();

    // Anti-vacuity: the CRS in the same fixture IS still read, so the refusal
    // is scoped to the placement rather than the whole extractor bailing out.
    expect(geo?.projectedCRS?.name).toBe('EPSG:2056');
  });

  it('keeps a genuine zero easting', async () => {
    // The other direction: 0 is a legal easting and must survive.
    const geo = extractGeoreferencingOnDemand(
      await storeOf(georefFile('0.', '1200000.', '400.')),
    );
    expect(geo?.mapConversion).toBeDefined();
    expect(geo!.mapConversion!.eastings).toBe(0);
  });
});

describe('getNumber/getReference guard their number branch too', () => {
  // The string branch was guarded first; a caller handing in an actual
  // `Infinity`/`NaN` bypassed the guard entirely, so the contract read
  // "finite, unless you passed a number". NaN, Infinity and -Infinity are
  // asserted separately: only the infinities survive an `isNaN` guard, so a
  // mutation back to `isNaN` fails a different subset of these.
  it.each([
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN', NaN],
  ])('getNumber(%s) is undefined', (_label, input) => {
    expect(getNumber(input)).toBeUndefined();
  });

  it.each([
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN', NaN],
  ])('getReference(%s) is undefined', (_label, input) => {
    expect(getReference(input)).toBeUndefined();
  });

  it('finite numbers still pass through both helpers (negative control)', () => {
    expect(getNumber(0)).toBe(0);
    expect(getNumber(2.5)).toBe(2.5);
    expect(getNumber(Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
    expect(getReference(0)).toBe(0);
    expect(getReference(42)).toBe(42);
  });
});

describe('an overflowing express id is refused before it is indexed', () => {
  const HUGE_A = '1'.repeat(400);
  const HUGE_B = '2'.repeat(400);

  it('ordinary ids tokenize on both scan paths (negative control)', () => {
    const src = new TextEncoder().encode(
      `#1=IFCWALL('a',$,$,$,$,$,$,$);\n#2=IFCWALL('b',$,$,$,$,$,$,$);`,
    );
    expect([...new StepTokenizer(src).scanEntitiesFast()].map((r) => r.expressId)).toEqual([1, 2]);
    expect([...new StepTokenizer(src).scanEntities()].map((r) => r.expressId)).toEqual([1, 2]);
  });

  it.each([
    ['scanEntitiesFast', (s: Uint8Array) => [...new StepTokenizer(s).scanEntitiesFast()]],
    ['scanEntities', (s: Uint8Array) => [...new StepTokenizer(s).scanEntities()]],
  ])('%s refuses overflowing ids rather than collapsing them onto Infinity', (_name, scan) => {
    // Anti-vacuity: these really are the overflowing shape, and the tokenizer's
    // `id*10+digit` accumulator maps BOTH of them to the SAME Infinity — which
    // is a collision between two distinct records, not merely one lost record.
    expect(Number(HUGE_A)).toBe(Infinity);
    expect(Number(HUGE_B)).toBe(Infinity);

    const src = new TextEncoder().encode(
      `#${HUGE_A}=IFCWALL('a',$,$,$,$,$,$,$);\n` +
      `#${HUGE_B}=IFCWALL('b',$,$,$,$,$,$,$);\n` +
      `#3=IFCWALL('c',$,$,$,$,$,$,$);`,
    );
    const ids = scan(src).map((r) => r.expressId);
    expect(ids).toEqual([3]);
    expect(ids).not.toContain(Infinity);
    // No two records share a key.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('readRefId refuses an overflowing reference on the byte-level path', () => {
    const read = (text: string) => {
      const b = new TextEncoder().encode(text);
      return readRefId(b, 0, b.length);
    };
    expect(read('#42,')[0]).toBe(42); // negative control
    expect(read('#0,')[0]).toBe(0); // negative control: id 0 is a value, not "absent"
    expect(read(`#${HUGE_A},`)[0]).toBe(-1);
    // `pos` is still advanced past the digits, so scanning resumes correctly.
    expect(read(`#${HUGE_A},`)[1]).toBe(HUGE_A.length + 1);
  });

  it('leaves no half-alive record: the pset is not readable at Infinity', async () => {
    const store = await storeOf(`${OWNER}
#${HUGE_A}=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#20=IFCPROPERTYSINGLEVALUE('P',$,IFCREAL(2.5),$);
#30=IFCPROPERTYSET('pset-guid',#1,'Pset_Test',$,(#20));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#${HUGE_A}),#30);`);

    // Before the byte-level `readRefId` was guarded, the entity index refused
    // the record but `extractPropertiesOnDemand` still served its pset under
    // the key `Infinity` — present enough to answer a property query, absent
    // enough that its own GlobalId and Name were unreadable.
    expect(store.entityIndex.byId.get(Infinity)).toBeUndefined();
    expect(extractPropertiesOnDemand(store, Infinity)).toEqual([]);
  });

  it('a normal element still resolves its pset (negative control)', async () => {
    const store = await storeOf(`${OWNER}
#10=IFCWALLSTANDARDCASE('wall-guid',#1,'Wall A',$,$,$,$,$);
#20=IFCPROPERTYSINGLEVALUE('P',$,IFCREAL(2.5),$);
#30=IFCPROPERTYSET('pset-guid',#1,'Pset_Test',$,(#20));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#10),#30);`);
    const psets = extractPropertiesOnDemand(store, 10);
    expect(psets).toHaveLength(1);
    expect(psets[0].properties[0].value).toBe(2.5);
  });
});

/**
 * The collision the `Number.isFinite` guard above missed: doubles lose
 * integer precision at 2^53 (~16 digits), NOT at Infinity (~309 digits). Two
 * ids past that boundary accumulate to the SAME double well before either one
 * overflows, so a guard that only rejects Infinity lets both through and they
 * collide on one key — the exact hazard the PR's own rationale describes,
 * just at the wrong threshold. `Number.isSafeInteger` is a strict superset of
 * `Number.isFinite` for this purpose: it also rejects NaN, Infinity and
 * non-integers, so nothing the old guard caught is let back in.
 */
describe('an unsafe-integer express id that collides under isFinite is refused by isSafeInteger', () => {
  const ID_A = '100000000000000001';
  const ID_B = '100000000000000002';

  it('the two ids really do collide once accumulated as a double (anti-vacuity)', () => {
    expect(parseInt(ID_A, 10)).toBe(parseInt(ID_B, 10));
    expect(parseInt(ID_A, 10)).toBe(100000000000000000);
    // The collision is invisible to the old guard: both pass isFinite.
    expect(Number.isFinite(parseInt(ID_A, 10))).toBe(true);
    // ...and both are correctly rejected by the new guard.
    expect(Number.isSafeInteger(parseInt(ID_A, 10))).toBe(false);
  });

  it.each([
    ['scanEntitiesFast', (s: Uint8Array) => [...new StepTokenizer(s).scanEntitiesFast()]],
    ['scanEntities', (s: Uint8Array) => [...new StepTokenizer(s).scanEntities()]],
  ])('%s refuses both colliding ids rather than admitting a duplicate key', (_name, scan) => {
    const src = new TextEncoder().encode(
      `#${ID_A}=IFCWALL('a',$,$,$,$,$,$,$);\n` +
      `#${ID_B}=IFCWALL('b',$,$,$,$,$,$,$);\n` +
      `#3=IFCWALL('c',$,$,$,$,$,$,$);`,
    );
    const ids = scan(src).map((r) => r.expressId);
    expect(ids).toEqual([3]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('readRefId refuses an unsafe-integer colliding reference on the byte-level path', () => {
    const read = (text: string) => {
      const b = new TextEncoder().encode(text);
      return readRefId(b, 0, b.length);
    };
    expect(read('#42,')[0]).toBe(42); // negative control
    expect(read(`#${ID_A},`)[0]).toBe(-1);
    expect(read(`#${ID_B},`)[0]).toBe(-1);
    expect(read(`#${ID_A},`)[1]).toBe(ID_A.length + 1);
  });

  it('extractEntity refuses a record keyed by a colliding unsafe-integer id', () => {
    const record = `#${ID_A}=IFCCARTESIANPOINT((1.,2.,3.));`;
    const source = new TextEncoder().encode(record);
    const extractor = new EntityExtractor(source);
    // extractEntity re-derives the id from the record text itself
    // (`parseInt(match[1], 10)`), not from the caller-supplied ref, so a
    // deliberately wrong/absent expressId in the ref still exercises its own
    // guard rather than short-circuiting on it.
    const entity = extractor.extractEntity({
      expressId: -1,
      type: 'IFCCARTESIANPOINT',
      byteOffset: 0,
      byteLength: record.length,
      lineNumber: 1,
    });
    expect(entity).toBeNull();
  });

  it('the # reference branch (parseAttributeValue) refuses a colliding unsafe-integer reference', () => {
    const attrs = attributesOf(`#1=IFCRELAGGREGATES('g',$,$,$,#${ID_A},(#2));`);
    expect(attrs[4]).toBeNull();
    // Negative control: an ordinary reference still resolves.
    expect(attributesOf(`#1=IFCRELAGGREGATES('g',$,$,$,#42,(#2));`)[4]).toBe(42);
  });

  it('getReference refuses a colliding unsafe-integer id on the string branch', () => {
    expect(getReference('#42')).toBe(42); // negative control
    expect(getReference(`#${ID_A}`)).toBeUndefined();
    expect(getReference(`#${ID_B}`)).toBeUndefined();
  });

  it('getReference refuses a colliding unsafe-integer id on the number branch', () => {
    expect(getReference(42)).toBe(42); // negative control
    expect(getReference(100000000000000000)).toBeUndefined();
  });

  it('two distinct records at colliding ids leave no half-alive entity in the index', async () => {
    const store = await storeOf(`${OWNER}
#${ID_A}=IFCWALLSTANDARDCASE('wall-a-guid',#1,'Wall A',$,$,$,$,$);
#${ID_B}=IFCWALLSTANDARDCASE('wall-b-guid',#1,'Wall B',$,$,$,$,$);
#20=IFCPROPERTYSINGLEVALUE('P',$,IFCREAL(2.5),$);
#30=IFCPROPERTYSET('pset-guid',#1,'Pset_Test',$,(#20));
#40=IFCRELDEFINESBYPROPERTIES('rel-guid',#1,$,$,(#${ID_A}),#30);`);
    // Neither record is indexed under the collided key, and no pset is
    // servable there — the same half-alive-record hazard as the Infinity
    // case, just at the digit count that actually occurs in practice.
    expect(store.entityIndex.byId.get(100000000000000000)).toBeUndefined();
    expect(extractPropertiesOnDemand(store, 100000000000000000)).toEqual([]);
  });
});
