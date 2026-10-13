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
 * unit through a parsed model and the public readers. The two limits and most
 * shapes mirror the Rust tests in `rust/core/src/project_units/tests.rs`
 * (#4603); where a refused assignment unit lands differs, as
 * `project-unit-walk.ts` says.
 */

import { describe, it, expect } from 'vitest';
import { EntityExtractor } from './entity-extractor.js';
import { extractProjectUnits, resolveUnitByRef, type UnitEntityReader } from './project-units.js';
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

/** `levels` derived units, each listing the next one `k` times: acyclic, no id repeats on a path. */
function fanOut(levels: number, k: number): string[] {
  const lines: string[] = [];
  for (let level = 0; level < levels; level++) {
    const unit = 10 + level * 10;
    const elements = Array.from({ length: k }, (_, i) => unit + 1 + i);
    lines.push(`#${unit}=IFCDERIVEDUNIT((${elements.map((e) => `#${e}`).join(',')}),.LINEARVELOCITYUNIT.,$);`,
      ...elements.map((e) => `#${e}=IFCDERIVEDUNITELEMENT(#${unit + 10},1);`));
  }
  return [...lines, METRE(10 + levels * 10)];
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
      '#1=IFCPROJECT(\'0000000000000000000001\',$,\'P\',$,$,$,$,$,#3);', METRE(2), '#3=IFCUNITASSIGNMENT((#2,#10));',
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

  it('the read budget admits a unit of 127 elements and refuses 128, not truncates it', () => {
    // One read for the unit and two per element (the element and its metre): 1 + 2 * 127 = 255 of 256.
    const wide = (n: number) => {
      const elements = Array.from({ length: n }, (_, i) => 100 + 2 * i);
      return [
        `#10=IFCDERIVEDUNIT((${elements.map((e) => `#${e}`).join(',')}),.USERDEFINED.,$);`,
        ...elements.flatMap((e) => [`#${e}=IFCDERIVEDUNITELEMENT(#${e + 1},1);`, METRE(e + 1)]),
      ];
    };
    expect(resolve(wide(127))?.resolved.siScale).toBe(1);
    expect(resolve(wide(128))).toBeNull();
  });

  it('a walk that runs out inside a conversion factor refuses the unit, not completes it from the unit name', () => {
    // 1 + 126 * 2 reads for the derived unit and its metre elements, then the foot element (254),
    // the foot (255) and its factor (256): the factor's UnitComponent is the first read refused,
    // which on its own would fall back to FOOT's named factor and complete the unit.
    const metres = Array.from({ length: 126 }, (_, i) => 100 + i);
    const lines = [
      '#1=IFCPROJECT(\'0000000000000000000001\',$,\'P\',$,$,$,$,$,#3);', METRE(2), '#3=IFCUNITASSIGNMENT((#2,#10));',
      `#10=IFCDERIVEDUNIT((${[...metres, 500].map((e) => `#${e}`).join(',')}),.USERDEFINED.,$);`,
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

  it("the native read path refuses a cycle and a chain past the depth cap, and leaves a fan-out to the caller's own read limit", () => {
    // Native callers count every read and throw past their limit (#7353); this
    // reader does the same, so the test sees which bound ends the walk.
    const read = (lines: string[], limit: number): UnitEntityReader => {
      const { extractor, entityIndex } = indexed(lines);
      let reads = 0;
      return (id) => {
        if (++reads > limit) throw new Error('Native project unit dependencies exceed the read limit');
        const ref = entityIndex.byId.get(id);
        return ref ? extractor.extractEntity(ref) : null;
      };
    };
    const native = (lines: string[]) => {
      const { extractor, entityIndex } = indexed(lines);
      return resolveUnitByRef(extractor, entityIndex, 10, read(lines, 512));
    };
    expect(native(['#10=IFCDERIVEDUNIT((#11),.USERDEFINED.,$);', '#11=IFCDERIVEDUNITELEMENT(#10,1);'])).toBeNull();
    // The same depth cap as the source path, well inside the 512 reads.
    expect(native(chain(15))?.resolved).toEqual({ symbol: 'm', siScale: 1 });
    expect(native(chain(16))).toBeNull();
    expect(() => native(fanOut(10, 4))).toThrow(/exceed the read limit/);
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
      `#10=IFCDERIVEDUNIT((${elements.map((e) => `#${e}`).join(',')}),.USERDEFINED.,$);`,
      ...bases.flatMap((base, i) => [`#${elements[i]}=IFCDERIVEDUNITELEMENT(#${elements[i] + 1},1);`, `#${elements[i] + 1}=IFCSIUNIT(*,${base});`]),
    ]);
    expect(out?.resolved.symbol).toBe('m·kg·s·A·K·mol·cd');
    expect(out?.resolved.siScale).toBe(1);
  });
});
