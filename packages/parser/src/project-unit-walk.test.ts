/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7547: the `IfcDerivedUnit -> IfcDerivedUnitElement -> Unit` walk in
 * `project-units.ts` had no bound on the parsed-source path. A derived unit
 * naming itself, or a long acyclic chain, threw `RangeError: Maximum call
 * stack size exceeded`; an acyclic fan-out ran for seconds and composed a
 * symbol exponential in its depth. These drive the resolver over a STEP text
 * indexed by hand, without the parser, so each shape is the only thing under
 * test; `test/project-unit-walk.parsed-model.test.ts` reads the self-referencing
 * unit and the wide flat units through a parsed model and the public readers.
 * The two limits and most shapes mirror the Rust tests in
 * `rust/core/src/project_units/tests.rs` (#4603). Some things differ, as
 * `project-unit-walk.ts` says. One is where a refused assignment unit lands.
 * Another is what the read budget charges here: only reads the schema does
 * not allow in a flat derived unit. So a flat unit of any width resolves as it
 * did before the bound. And each free read inside the top-level unit is made
 * once per walk. Many tests count the reads of each entity through an
 * extractor that wraps `extractEntity`. The native read path keeps its walk
 * from before #7547; its callers' read limits bound it.
 */

import { describe, it, expect, vi } from 'vitest';
import { EntityExtractor } from './entity-extractor.js';
import { ProjectUnitReadError, extractProjectUnits, resolveUnitByRef, type UnitEntityReader } from './project-units.js';
import type { EntityRef } from './types.js';

/** Source bytes plus an entity index over `#id=TYPE(...);` lines. */
function indexed(lines: string[]) {
  const content = lines.join('\n');
  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();
  let offset = 0;
  lines.forEach((line, i) => {
    const m = /^#(\d+)=([A-Z0-9_]+)\(/.exec(line);
    if (m) {
      const expressId = Number(m[1]);
      byId.set(expressId, { expressId, type: m[2], byteOffset: offset, byteLength: line.length, lineNumber: i + 1 });
      const ids = byType.get(m[2]);
      if (ids) ids.push(expressId);
      else byType.set(m[2], [expressId]);
    }
    offset += line.length + 1; // '\n'; the fixtures are ASCII
  });
  const source = new TextEncoder().encode(content);
  return { source, entityIndex: { byId, byType }, extractor: new EntityExtractor(source) };
}

function resolve(lines: string[], ref = 10) {
  const { extractor, entityIndex } = indexed(lines);
  return resolveUnitByRef(extractor, entityIndex, ref);
}

/** A native reader over `lines`, as the current-model callers pass one: it reads through the extractor. */
function nativeReader(lines: string[]) {
  const { source, entityIndex, extractor } = indexed(lines);
  const read: UnitEntityReader = (id) => {
    const ref = entityIndex.byId.get(id);
    return ref ? extractor.extractEntity(ref) : null;
  };
  return { source, entityIndex, extractor, read };
}

const PROJECT = "#1=IFCPROJECT('0000000000000000000001',$,'P',$,$,$,$,$,#3);";
const METRE = (id: number) => `#${id}=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`;
const SECOND = (id: number) => `#${id}=IFCSIUNIT(*,.TIMEUNIT.,$,.SECOND.);`;

/** `n` derived units, each the only element of the one before, ending in a metre at the bottom. */
function chain(n: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const unit = 10 + 2 * i;
    lines.push(`#${unit}=IFCDERIVEDUNIT((#${unit + 1}),.LINEARVELOCITYUNIT.,$);`, `#${unit + 1}=IFCDERIVEDUNITELEMENT(#${unit + 2},1);`);
  }
  return [...lines, METRE(10 + 2 * n)];
}

/** `levels` derived units from `#top`, each listing the next one `k` times: acyclic, no id repeats on a path. */
function fanOut(levels: number, k: number, top = 10): string[] {
  const lines: string[] = [];
  for (let level = 0; level < levels; level++) {
    const unit = top + level * 10;
    const elements = Array.from({ length: k }, (_, i) => unit + 1 + i);
    lines.push(`#${unit}=IFCDERIVEDUNIT((${elements.map((e) => `#${e}`).join(',')}),.LINEARVELOCITYUNIT.,$);`,
      ...elements.map((e) => `#${e}=IFCDERIVEDUNITELEMENT(#${unit + 10},1);`));
  }
  return [...lines, METRE(top + levels * 10)];
}

/**
 * The flat, schema-valid unit from the review of #7547: LINEARVELOCITYUNIT #10
 * over metre #2 and second #5, with `pairs` cancelling metre (+1, -1) pairs,
 * then metre +1 and second -1, each element its own entity: `2 * pairs + 2`
 * elements, m/s at scale 1.
 */
function velocity(pairs: number): string[] {
  const elements: Array<[number, number]> = [];
  for (let i = 0; i < pairs; i++) elements.push([2, 1], [2, -1]);
  elements.push([2, 1], [5, -1]);
  return [
    `#10=IFCDERIVEDUNIT((${elements.map((_, i) => `#${100 + i}`).join(',')}),.LINEARVELOCITYUNIT.,$);`,
    ...elements.map(([unit, exponent], i) => `#${100 + i}=IFCDERIVEDUNITELEMENT(#${unit},${exponent});`),
    METRE(2), SECOND(5),
  ];
}

/** The symbol composed for `velocity(pairs)`, pairs > 0: every element in order, nothing cancelled. */
const velocitySymbol = (pairs: number) => `${'m·'.repeat(pairs)}m/(${'m·'.repeat(pairs)}s)`;

/** Derived unit #10 whose one element names derived unit #20, of `n` metre elements: a nesting the schema does not allow. */
function nested(n: number): string[] {
  const elements = Array.from({ length: n }, (_, i) => 100 + 2 * i);
  return [
    "#10=IFCDERIVEDUNIT((#11),.USERDEFINED.,'outer');", '#11=IFCDERIVEDUNITELEMENT(#20,1);',
    `#20=IFCDERIVEDUNIT((${elements.map((e) => `#${e}`).join(',')}),.USERDEFINED.,'inner');`,
    ...elements.flatMap((e) => [`#${e}=IFCDERIVEDUNITELEMENT(#${e + 1},1);`, METRE(e + 1)]),
  ];
}

/** Derived unit #10 of `w` elements (#1000 on), each naming `unit` with exponent 1, then `rows`. */
function wideOver(w: number, unit: string, rows: string[]): string[] {
  const elements = Array.from({ length: w }, (_, i) => 1000 + i);
  return [
    `#10=IFCDERIVEDUNIT((${elements.map((e) => `#${e}`).join(',')}),.USERDEFINED.,'wide');`,
    ...elements.map((e) => `#${e}=IFCDERIVEDUNITELEMENT(${unit},1);`),
    ...rows,
  ];
}

/**
 * Length unit #b ('FOOT', exponents #b+3) over factor #b+1, a 1 m measure of metre #b+2.
 * `factor` and `component` replace those two rows.
 */
function footAt(b: number, rows: { factor?: string; component?: string } = {}): string[] {
  return [
    `#${b}=IFCCONVERSIONBASEDUNIT(#${b + 3},.LENGTHUNIT.,'FOOT',#${b + 1});`, `#${b + 3}=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);`,
    rows.factor ?? `#${b + 1}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#${b + 2});`, rows.component ?? METRE(b + 2),
  ];
}

/** The first id of copy `i` of a shape: copies sit 10 ids apart from #10000. */
const at = (i: number) => 10_000 + 10 * i;

/**
 * Derived unit #10 of `w` elements (#1000 on). Element `i` names its own copy of a
 * shape, `rows(at(i))`, whose first id is the unit it names.
 */
function wideEach(w: number, rows: (b: number) => string[]): string[] {
  const elements = Array.from({ length: w }, (_, i) => 1000 + i);
  return [
    `#10=IFCDERIVEDUNIT((${elements.map((e) => `#${e}`).join(',')}),.USERDEFINED.,'wide');`,
    ...elements.map((e, i) => `#${e}=IFCDERIVEDUNITELEMENT(#${at(i)},1);`),
    ...elements.flatMap((_, i) => rows(at(i))),
  ];
}

/** How many of the `w` copies had entity `at(i) + offset` read exactly once. */
const copiesReadOnce = (reads: (id: number) => number, w: number, offset: number) =>
  Array.from({ length: w }, (_, i) => reads(at(i) + offset)).filter((n) => n === 1).length;

const POINT = (id: number) => `#${id}=IFCCARTESIANPOINT((0.,0.,0.));`;
const FEET = Array(300).fill('ft').join('·');

/** Resolve #10 through an extractor that wraps `extractEntity` and counts its reads of each entity. */
function counted(lines: string[]) {
  const { source, entityIndex } = indexed(lines);
  const reads = new Map<number, number>();
  class CountingExtractor extends EntityExtractor {
    override extractEntity(ref: EntityRef) {
      reads.set(ref.expressId, (reads.get(ref.expressId) ?? 0) + 1);
      return super.extractEntity(ref);
    }
  }
  const out = resolveUnitByRef(new CountingExtractor(source), entityIndex, 10);
  return { out, reads: (id: number) => reads.get(id) ?? 0 };
}

/** Run `body` while `Array.prototype.join` refuses a result over `limit` characters, as V8 does past its string limit. */
function withStringLimit<T>(limit: number, body: () => T, error: () => Error = () => new RangeError('Invalid string length')): T {
  const join = Array.prototype.join;
  const spy = vi.spyOn(Array.prototype, 'join').mockImplementation(function (this: unknown[], separator?: string) {
    const out = join.call(this, separator);
    if (out.length > limit) throw error();
    return out;
  });
  try {
    return body();
  } finally {
    spy.mockRestore();
  }
}

describe('the unit walk is bounded on the parsed-source path (#7547)', () => {
  it('a derived unit that names itself is unresolved, not a stack overflow', () => {
    expect(resolve(['#10=IFCDERIVEDUNIT((#11),.USERDEFINED.,$);', '#11=IFCDERIVEDUNITELEMENT(#10,1);'])).toBeNull();
  });

  it('a cycle through two derived units is unresolved', () => {
    expect(resolve([
      '#10=IFCDERIVEDUNIT((#11),.LINEARVELOCITYUNIT.,$);', '#11=IFCDERIVEDUNITELEMENT(#12,1);',
      '#12=IFCDERIVEDUNIT((#13),.LINEARVELOCITYUNIT.,$);', '#13=IFCDERIVEDUNITELEMENT(#10,1);',
    ])).toBeNull();
  });

  it('a cyclic element beside two sound ones refuses the whole unit, not a truncated m/s', () => {
    const lines = [
      PROJECT, METRE(2), '#3=IFCUNITASSIGNMENT((#2,#10));',
      '#10=IFCDERIVEDUNIT((#11,#12,#13),.LINEARVELOCITYUNIT.,$);',
      '#11=IFCDERIVEDUNITELEMENT(#10,1);', '#12=IFCDERIVEDUNITELEMENT(#20,1);', '#13=IFCDERIVEDUNITELEMENT(#21,-1);',
      METRE(20), SECOND(21),
    ];
    expect(resolve(lines)).toBeNull();
    // In the assignment it stays declared, so it shows no unit rather than the m/s default (#4690),
    // and the walk over it leaves the sibling LENGTHUNIT alone.
    const { source, entityIndex } = indexed(lines);
    const units = extractProjectUnits(source, entityIndex);
    expect(units.unitForMeasure('IfcLinearVelocityMeasure')).toBeNull();
    expect(units.resolvedForUnitType('LENGTHUNIT')).toEqual({ symbol: 'm', siScale: 1 });
  });

  it('an acyclic chain past the depth cap is unresolved, not a stack overflow', () => {
    // Far past V8's stack, so the result does not depend on JIT state or the Node version.
    expect(resolve(chain(100_000))).toBeNull();
  });

  it('the depth cap admits 15 nested derived units and refuses 16, as in Rust', () => {
    // 15 derived units plus the metre fill the 16 places on the path (MAX_UNIT_RESOLVE_DEPTH in both).
    expect(resolve(chain(15))?.resolved).toEqual({ symbol: 'm', siScale: 1 });
    expect(resolve(chain(16))).toBeNull();
  });

  it('an acyclic fan-out is refused inside the read budget, not composed', () => {
    // Before #7547: 4^10 element resolutions, about 2.5 s, and a 2,097,151-character symbol.
    const started = performance.now();
    const out = resolve(fanOut(10, 4));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out).toBeNull();
  });

  it('the read budget admits a nested unit of 127 elements and refuses 128, not truncates it', () => {
    // The nested unit's read and two per element (the element and its metre): 1 + 2 * 127 = 255 of 256.
    // The outer unit and its element are not charged.
    expect(resolve(nested(127))?.resolved.siScale).toBe(1);
    expect(resolve(nested(128))).toBeNull();
  });

  it('one budget covers every nested unit of a walk, also one named twice', () => {
    // Two elements naming the same nested unit of n metres: 2 * (1 + 2n) reads, 254 for 63 and 258 for 64.
    const twice = (n: number) => {
      const [, element, ...inner] = nested(n);
      return ["#10=IFCDERIVEDUNIT((#11,#12),.USERDEFINED.,'outer');", element, '#12=IFCDERIVEDUNITELEMENT(#20,-1);', ...inner];
    };
    expect(resolve(twice(63))?.resolved.siScale).toBe(1);
    expect(resolve(twice(64))).toBeNull();
  });

  it('a wide unit whose elements all name a nested fan-out is refused in bounded time', () => {
    // 10,000 elements naming #20, a fan-out of 3 levels by 4 (169 charged reads a visit): the
    // budget runs out on the second visit. Each element after it costs one free read: the
    // element itself, since the nested unit is refused before it is read.
    const elements = Array.from({ length: 10_000 }, (_, i) => 100_000 + i);
    const lines = [
      `#10=IFCDERIVEDUNIT((${elements.map((e) => `#${e}`).join(',')}),.LINEARVELOCITYUNIT.,$);`,
      ...elements.map((e) => `#${e}=IFCDERIVEDUNITELEMENT(#20,1);`), ...fanOut(3, 4, 20),
    ];
    const started = performance.now();
    const out = resolve(lines);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out).toBeNull();
  });

  it('a walk that runs out inside a conversion factor refuses the unit, not completes it from the unit name', () => {
    // The nested unit #20 (1 read) and its 126 metre elements (2 each) take 253 reads. Then come the
    // foot element (254), the foot (255) and its factor (256). The factor's UnitComponent is the first
    // read refused. On its own, that refusal would fall back to FOOT's named factor and complete the unit.
    const metres = Array.from({ length: 126 }, (_, i) => 100 + i);
    const lines = [
      PROJECT, METRE(2), '#3=IFCUNITASSIGNMENT((#2,#10));',
      "#10=IFCDERIVEDUNIT((#11),.USERDEFINED.,'outer');", '#11=IFCDERIVEDUNITELEMENT(#20,1);',
      `#20=IFCDERIVEDUNIT((${[...metres, 500].map((e) => `#${e}`).join(',')}),.USERDEFINED.,'inner');`,
      ...metres.map((e) => `#${e}=IFCDERIVEDUNITELEMENT(#2,1);`),
      '#500=IFCDERIVEDUNITELEMENT(#501,1);', "#501=IFCCONVERSIONBASEDUNIT(#503,.LENGTHUNIT.,'FOOT',#502);",
      '#502=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#2);', '#503=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);',
    ];
    expect(resolve(lines)).toBeNull();
    const { source, entityIndex } = indexed(lines);
    const units = extractProjectUnits(source, entityIndex);
    expect(units.declaredCount).toBe(2);
    expect(units.resolvedForUnitType('USERDEFINED')).toBeUndefined();
  });
});

describe('the native read path keeps its walk from before #7547', () => {
  // Native callers count every read and throw past their limit (#7353); this
  // reader does the same, so each test sees which bound ends the walk.
  const native = (lines: string[], limit = 512) => {
    const { extractor, entityIndex, read } = nativeReader(lines);
    let reads = 0;
    return resolveUnitByRef(extractor, entityIndex, 10, (id) => {
      if (++reads > limit) throw new Error('Native project unit dependencies exceed the read limit');
      return read(id);
    });
  };

  it('a cycle is refused, as before', () => {
    expect(native(['#10=IFCDERIVEDUNIT((#11),.USERDEFINED.,$);', '#11=IFCDERIVEDUNITELEMENT(#10,1);'])).toBeNull();
  });

  it("no depth cap: a chain resolves until the caller's 512 reads run out", () => {
    // A chain of n reads 2n + 1 entities, so 255 levels fit in 512 reads and 256 do not.
    expect(native(chain(16))?.resolved).toEqual({ symbol: 'm', siScale: 1 });
    expect(native(chain(255))?.resolved).toEqual({ symbol: 'm', siScale: 1 });
    expect(() => native(chain(256))).toThrow(/exceed the read limit/);
  });

  it("no budget and no memo: a fan-out, and 300 elements over one metre, run into the caller's read limit", () => {
    expect(() => native(fanOut(10, 4))).toThrow(/exceed the read limit/);
    // The metre is read once per element: 1 + 2 * 300 reads.
    expect(() => native(wideOver(300, '#20', [METRE(20)]))).toThrow(/exceed the read limit/);
    expect(native(wideOver(300, '#20', [METRE(20)]), 601)?.resolved.symbol).toBe(Array(300).fill('m').join('·'));
  });

  it('extractProjectUnits with a reader resolves a chain of 16 nested derived units, as main did', () => {
    const { source, entityIndex, read } = nativeReader([PROJECT, '#3=IFCUNITASSIGNMENT((#10));', ...chain(16)]);
    const units = extractProjectUnits(source, entityIndex, undefined, read);
    expect(units.resolvedForUnitType('LINEARVELOCITYUNIT')).toEqual({ symbol: 'm', siScale: 1 });
  });
});

describe('a flat derived unit resolves at any width, as before the bound (#7547)', () => {
  it("the review's example, 128 elements, is m/s at scale 1, as its two-element control is", () => {
    expect(resolve(velocity(0))?.resolved).toEqual({ symbol: 'm/s', siScale: 1 });
    // 63 cancelling metre pairs, then metre +1 and second -1.
    const out = resolve(velocity(63));
    expect(out?.unitType).toBe('LINEARVELOCITYUNIT');
    expect(out?.resolved).toEqual({ symbol: velocitySymbol(63), siScale: 1 });
  });

  it('300 and 10,000 elements resolve too, the symbol growing linearly with the width', () => {
    // 149 and 4,999 pairs: 4 * pairs + 5 characters.
    expect(resolve(velocity(149))?.resolved).toEqual({ symbol: velocitySymbol(149), siScale: 1 });
    expect(resolve(velocity(4_999))?.resolved).toEqual({ symbol: velocitySymbol(4_999), siScale: 1 });
  });

  it('in the project assignment, a flat unit of 10,000 elements is the declared LINEARVELOCITYUNIT', () => {
    const { source, entityIndex } = indexed([PROJECT, '#3=IFCUNITASSIGNMENT((#2,#5,#10));', ...velocity(4_999)]);
    const units = extractProjectUnits(source, entityIndex);
    expect(units.declaredCount).toBe(3);
    expect(units.unitForMeasure('IfcLinearVelocityMeasure')).toEqual({ symbol: velocitySymbol(4_999), siScale: 1 });
  });

  it("only a nested unit's reads are charged: 300 named-unit elements beside it stay free", () => {
    // The outer unit lists the nested unit of 4 metres (9 charged reads), then 300 metre elements.
    const [, element, ...inner] = nested(4);
    const metres = Array.from({ length: 300 }, (_, i) => 1000 + i);
    const out = resolve([
      `#10=IFCDERIVEDUNIT((#11,${metres.map((e) => `#${e}`).join(',')}),.USERDEFINED.,'outer');`, element, ...inner,
      ...metres.map((e) => `#${e}=IFCDERIVEDUNITELEMENT(#2,1);`), METRE(2),
    ]);
    expect(out?.resolved).toEqual({ symbol: Array(304).fill('m').join('·'), siScale: 1 });
  });
});

describe('inside the top-level unit, only what the schema allows is free (#7547)', () => {
  // 300 elements, each naming its own copy of the shape: 300 free reads of each entity under
  // test, past the 256 reads the budget allows. Each copy is read once.
  it.each([
    ['an IfcSIUnit', (b: number) => [METRE(b)], [0], true],
    ["an IfcConversionBasedUnit, its IfcMeasureWithUnit and that measure's IfcSIUnit", (b: number) => footAt(b), [0, 1, 2], true],
    ['an IfcConversionBasedUnitWithOffset', (b: number) => [
      `#${b}=IFCCONVERSIONBASEDUNITWITHOFFSET(#${b + 3},.THERMODYNAMICTEMPERATUREUNIT.,'DEGREE_FAHRENHEIT',#${b + 1},-459.67);`,
      `#${b + 3}=IFCDIMENSIONALEXPONENTS(0,0,0,0,1,0,0);`, `#${b + 1}=IFCMEASUREWITHUNIT(IFCTHERMODYNAMICTEMPERATUREMEASURE(0.5),#${b + 2});`,
      `#${b + 2}=IFCSIUNIT(*,.THERMODYNAMICTEMPERATUREUNIT.,$,.KELVIN.);`], [0, 1, 2], true],
    // This reader cannot resolve a context-dependent unit, so the derived unit is not resolved either, as before.
    ['an IfcContextDependentUnit', (b: number) => [`#${b}=IFCCONTEXTDEPENDENTUNIT(#${b + 3},.USERDEFINED.,'box');`,
      `#${b + 3}=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);`], [0], false],
    ['a foot whose factor names an IfcDerivedUnit', (b: number) => footAt(b, { component: `#${b + 2}=IFCDERIVEDUNIT((#${b + 4}),.USERDEFINED.,'d');` }), [2], true],
    ['a foot whose factor names an IfcMonetaryUnit', (b: number) => footAt(b, { component: `#${b + 2}=IFCMONETARYUNIT('EUR');` }), [2], true],
    // A UnitComponent that is not an IfcSIUnit is taken at 1.0, as before.
    ['a foot whose factor names an IfcConversionBasedUnit', (b: number) => [
      ...footAt(b, { component: `#${b + 2}=IFCCONVERSIONBASEDUNIT(#${b + 3},.LENGTHUNIT.,'INCH',#${b + 4});` }),
      `#${b + 4}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.0254),#${b + 5});`, METRE(b + 5)], [2], true],
    ['a foot whose factor names an IfcConversionBasedUnitWithOffset', (b: number) => [
      ...footAt(b, { component: `#${b + 2}=IFCCONVERSIONBASEDUNITWITHOFFSET(#${b + 3},.LENGTHUNIT.,'OFFSET_FOOT',#${b + 4},1.);` }),
      `#${b + 4}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#${b + 5});`, METRE(b + 5)], [2], true],
    ['a foot whose factor names an IfcContextDependentUnit', (b: number) => footAt(b, { component: `#${b + 2}=IFCCONTEXTDEPENDENTUNIT(#${b + 3},.LENGTHUNIT.,'span');` }), [2], true],
  ] as Array<[string, (b: number) => string[], number[], boolean]>)('300 elements, each naming its own copy of %s: every copy is read once, uncharged', (_, rows, offsets, resolves) => {
    const { out, reads } = counted(wideEach(300, rows));
    expect(out !== null).toBe(resolves);
    for (const offset of offsets) expect(copiesReadOnce(reads, 300, offset), `+${offset}`).toBe(300);
  });

  // Each read the schema does not allow is charged before it is made, so the target is read
  // 256 times, then the budget refuses the unit. Main read it 300 times, and composed the unit
  // in the last three cases.
  it.each([
    ['an element that is not an IfcDerivedUnitElement', [`#10=IFCDERIVEDUNIT((${Array(300).fill('#20').join(',')}),.USERDEFINED.,'wide');`, METRE(20)], 20],
    ['a Unit that is not a unit', wideOver(300, '#20', [POINT(20)]), 20],
    ['a Unit that is an IfcMonetaryUnit', wideOver(300, '#20', ["#20=IFCMONETARYUNIT('EUR');"]), 20],
    ['a ConversionFactor that is not an IfcMeasureWithUnit, shared by 300 feet', [
      ...wideEach(300, (b) => [`#${b}=IFCCONVERSIONBASEDUNIT(#23,.LENGTHUNIT.,'FOOT',#21);`]),
      '#23=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);', POINT(21)], 21],
    ['a UnitComponent that is not a unit, shared by the factors of 300 feet', [
      ...wideEach(300, (b) => footAt(b, { factor: `#${b + 1}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#22);`, component: '' })), POINT(22)], 22],
  ] as Array<[string, string[], number]>)('%s is charged: read 256 times, then the unit is refused', (_, lines, id) => {
    const { out, reads } = counted(lines);
    expect(out).toBeNull();
    expect(reads(id)).toBe(256);
  });

  it("a dangling ConversionFactor or UnitComponent reads nothing and costs nothing: the foot's named factor completes it, as before", () => {
    // 300 feet, each with its own dangling reference: a charge for each would refuse the unit.
    expect(counted(wideEach(300, (b) => footAt(b, { factor: '', component: '' }))).out?.resolved.symbol).toBe(FEET);
    const noComponent = counted(wideEach(300, (b) => footAt(b, { component: '' })));
    expect(noComponent.out?.resolved.symbol).toBe(FEET);
    expect(copiesReadOnce(noComponent.reads, 300, 1)).toBe(300);
  });

  it('a nested unit is charged before it is read: 1,000 elements over it read it once, not 1,000 times', () => {
    // The first visit spends the budget inside #20 (its own read, then two per metre element), so
    // every later element is refused before #20 is read. Charged after the read, #20 is read 1,000 times.
    const [, , ...inner] = nested(300);
    const { out, reads } = counted(wideOver(1_000, '#20', inner));
    expect(out).toBeNull();
    expect(reads(20)).toBe(1);
  });

  it('the charged reads of a walk parse at most 64 KiB: a nested unit of 4,000 `$` elements is read 8 times, not 256', () => {
    // Each visit is one charged read of #20. Its list holds no reference, so the read count alone
    // would allow 256 full parses of it.
    const inner = `#20=IFCDERIVEDUNIT((${Array(4_000).fill('$').join(',')}),.USERDEFINED.,'inner');`;
    const { out, reads } = counted(wideOver(1_000, '#20', [inner]));
    expect(out).toBeNull();
    expect(inner.length).toBe(8_044);
    expect(reads(20)).toBe(Math.floor((64 * 1024) / inner.length));
  });

  it('64 KiB itself is allowed: a nested unit of 8,192 bytes is read 8 times, and the ninth read is refused', () => {
    // 4,074 `$` make the record 8,192 bytes, so 8 charged reads parse exactly 65,536 bytes. Only more
    // than 64 KiB is refused: the ninth charge would make 73,728, so #20 is not read a ninth time.
    const inner = `#20=IFCDERIVEDUNIT((${Array(4_074).fill('$').join(',')}),.USERDEFINED.,'inner');`;
    const lines = wideOver(1_000, '#20', [inner]);
    expect(indexed(lines).entityIndex.byId.get(20)?.byteLength).toBe(8_192);
    const { out, reads } = counted(lines);
    expect(out).toBeNull();
    expect(reads(20)).toBe(8);
  });
});

describe('inside the top-level unit, each free read is made once per walk (#7547)', () => {
  it("a named unit is resolved once however many elements name it: the review's example reads metre and second once", () => {
    const { out, reads } = counted(velocity(63));
    expect(out?.resolved).toEqual({ symbol: velocitySymbol(63), siScale: 1 });
    expect([reads(2), reads(5)]).toEqual([1, 1]);
    // Each of the 128 elements is still read, once.
    expect(Array.from({ length: 128 }, (_, i) => reads(100 + i)).every((n) => n === 1)).toBe(true);
  });

  it('a foot named by 300 elements is read once, with its factor and their metre', () => {
    const { out, reads } = counted(wideOver(300, '#20', footAt(20)));
    expect(out?.resolved).toEqual({ symbol: FEET, siScale: 1 });
    expect([reads(20), reads(21), reads(22)]).toEqual([1, 1, 1]);
  });

  it('a factor shared by 300 feet is read once, and so is a UnitComponent shared by 300 factors', () => {
    const sharedFactor = counted([
      ...wideEach(300, (b) => [`#${b}=IFCCONVERSIONBASEDUNIT(#23,.LENGTHUNIT.,'FOOT',#21);`]),
      '#23=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);', '#21=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#22);', METRE(22),
    ]);
    expect(sharedFactor.out?.resolved).toEqual({ symbol: FEET, siScale: 1 });
    expect([sharedFactor.reads(21), sharedFactor.reads(22)]).toEqual([1, 1]);
    const sharedComponent = counted([
      ...wideEach(300, (b) => footAt(b, { factor: `#${b + 1}=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#22);`, component: '' })), METRE(22),
    ]);
    expect(sharedComponent.out?.resolved).toEqual({ symbol: FEET, siScale: 1 });
    expect(copiesReadOnce(sharedComponent.reads, 300, 1)).toBe(300);
    expect(sharedComponent.reads(22)).toBe(1);
  });

  it("a metre that is 300 elements' Unit and the UnitComponent of 300 feet is read once in each place", () => {
    // The metre is free in two places. As a Unit its resolution is kept, as a UnitComponent the record
    // read. Each place keeps its own memo, so the metre is read twice. Main read it 600 times.
    const metres = Array.from({ length: 300 }, (_, i) => 1000 + i);
    const feet = Array.from({ length: 300 }, (_, i) => 2000 + i);
    const { out, reads } = counted([
      `#10=IFCDERIVEDUNIT((${[...metres, ...feet].map((e) => `#${e}`).join(',')}),.USERDEFINED.,'ratio');`,
      ...metres.map((e) => `#${e}=IFCDERIVEDUNITELEMENT(#2,1);`), ...feet.map((e) => `#${e}=IFCDERIVEDUNITELEMENT(#20,-1);`),
      METRE(2), "#20=IFCCONVERSIONBASEDUNIT(#23,.LENGTHUNIT.,'FOOT',#21);",
      '#23=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);', '#21=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#2);',
    ]);
    expect(out?.resolved.symbol).toBe(`${Array(300).fill('m').join('·')}/(${FEET})`);
    expect((out?.resolved.siScale ?? 0) / 0.3048 ** -300).toBeCloseTo(1, 9);
    expect(reads(2)).toBe(2);
  });

  it('an element id listed again is charged: one free read and 256 charged, then the unit is refused', () => {
    // `Elements` is a SET, so a real unit never lists one element twice. Main composed 300 metres.
    const { out, reads } = counted([`#10=IFCDERIVEDUNIT((${Array(300).fill('#11').join(',')}),.USERDEFINED.,'wide');`,
      '#11=IFCDERIVEDUNITELEMENT(#20,1);', METRE(20)]);
    expect(out).toBeNull();
    expect(reads(11)).toBe(257);
    expect(reads(20)).toBe(1);
  });

  it('nothing is kept between walks: each call reads the named unit again', () => {
    const { extractor, entityIndex } = indexed(wideOver(300, '#20', [METRE(20)]));
    const decode = vi.spyOn(extractor, 'extractEntity');
    resolveUnitByRef(extractor, entityIndex, 10);
    resolveUnitByRef(extractor, entityIndex, 10);
    expect(decode.mock.calls.filter(([ref]) => ref.expressId === 20)).toHaveLength(2);
  });
});

describe("a flat unit whose symbol passes the engine's string limit is unresolved, not a throw (#7547)", () => {
  // composeDerived joins the parts with Array.prototype.join, so the stand-in limit sits there.
  // 30 metre elements make 'm·m·…·m', 59 characters. Main threw the RangeError.
  const lines = [PROJECT, '#3=IFCUNITASSIGNMENT((#2,#10));', ...wideOver(30, '#2', [METRE(2)])];
  const metres = Array(30).fill('m').join('·');

  it('the stand-in limit is real: a join past it throws', () => {
    expect(() => withStringLimit(50, () => Array(30).fill('m').join('·'))).toThrow(RangeError);
  });

  it('resolveUnitByRef returns it unresolved; at the limit it resolves', () => {
    const { extractor, entityIndex } = indexed(lines);
    expect(withStringLimit(59, () => resolveUnitByRef(extractor, entityIndex, 10))?.resolved.symbol).toBe(metres);
    expect(withStringLimit(58, () => resolveUnitByRef(extractor, entityIndex, 10))).toBeNull();
  });

  it('extractProjectUnits keeps it declared without a scale, beside the metre', () => {
    const { source, entityIndex } = indexed(lines);
    const units = withStringLimit(58, () => extractProjectUnits(source, entityIndex));
    expect(units.declaredCount).toBe(2);
    expect(units.resolvedForUnitType('USERDEFINED')).toBeUndefined();
    expect(units.resolvedForUnitType('LENGTHUNIT')).toEqual({ symbol: 'm', siScale: 1 });
  });

  it('extractProjectUnits with a native reader refuses it as unresolved or unsupported, not RangeError', () => {
    const { source, entityIndex, read } = nativeReader(lines);
    const call = () => withStringLimit(58, () => extractProjectUnits(source, entityIndex, undefined, read));
    expect(call).toThrow(ProjectUnitReadError);
    expect(call).toThrow(/^Native project unit is unresolved or unsupported$/);
    expect(withStringLimit(59, () => extractProjectUnits(source, entityIndex, undefined, read)).resolvedForUnitType('USERDEFINED')?.symbol).toBe(metres);
  });

  it('any other error from composing the symbol is thrown on', () => {
    const { extractor, entityIndex } = indexed(lines);
    const notTheLimit = () => new TypeError('not the string limit');
    expect(() => withStringLimit(58, () => resolveUnitByRef(extractor, entityIndex, 10), notTheLimit)).toThrow(TypeError);
  });
});

describe('real units stay inside the bound (#7547)', () => {
  it('a flow rate over a conversion-based foot resolves as before', () => {
    const out = resolve([
      '#10=IFCDERIVEDUNIT((#11,#12),.VOLUMETRICFLOWRATEUNIT.,$);',
      '#11=IFCDERIVEDUNITELEMENT(#20,3);', '#12=IFCDERIVEDUNITELEMENT(#21,-1);',
      "#20=IFCCONVERSIONBASEDUNIT(#23,.LENGTHUNIT.,'FOOT',#30);", '#23=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);',
      '#30=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#22);', SECOND(21), METRE(22),
    ]);
    expect(out?.resolved.symbol).toBe('ft³/s');
    expect(out?.resolved.siScale).toBeCloseTo(0.3048 ** 3, 12);
  });

  it('a derived unit over all seven SI base units resolves', () => {
    const bases = ['.LENGTHUNIT.,$,.METRE.', '.MASSUNIT.,.KILO.,.GRAM.', '.TIMEUNIT.,$,.SECOND.', '.ELECTRICCURRENTUNIT.,$,.AMPERE.',
      '.THERMODYNAMICTEMPERATUREUNIT.,$,.KELVIN.', '.AMOUNTOFSUBSTANCEUNIT.,$,.MOLE.', '.LUMINOUSINTENSITYUNIT.,$,.CANDELA.'];
    const elements = bases.map((_, i) => 100 + 2 * i);
    const out = resolve([
      `#10=IFCDERIVEDUNIT((${elements.map((e) => `#${e}`).join(',')}),.USERDEFINED.,'all seven');`,
      ...bases.flatMap((base, i) => [`#${elements[i]}=IFCDERIVEDUNITELEMENT(#${elements[i] + 1},1);`, `#${elements[i] + 1}=IFCSIUNIT(*,${base});`]),
    ]);
    expect(out?.resolved.symbol).toBe('m·kg·s·A·K·mol·cd');
    expect(out?.resolved.siScale).toBe(1);
  });
});
