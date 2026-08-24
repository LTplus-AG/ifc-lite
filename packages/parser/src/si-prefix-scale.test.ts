/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { extractProjectUnits } from './project-units.js';
import { CONVERSION_BASED_UNIT_FACTORS } from './unit-extractor.js';
import type { EntityIndex, EntityRef } from './types.js';

/**
 * Pins the two length-scale tables against their EXTERNAL sources of truth:
 * the SI prefixes (BIPM / ISO 80000) and the imperial-to-metre factors (exact
 * by the 1959 international yard-and-pound agreement).
 *
 * Why this is needed. `project-units.parity.test.ts` and
 * `unit-scale.parity.test.ts` are strong tests, but they check TS against
 * Rust through six shared vectors, and those vectors only ever exercise
 * MILLI, CENTI, KILO and FOOT/INCH. Everything else in both tables is
 * unreached. Measured on this branch: setting 13 of the 16 SI prefixes to
 * wrong values AND breaking YARD and MILE at the same time leaves the parser
 * package at 660 of 661 tests passing. The single failure is INCH, which the
 * shared fixture does cover.
 *
 * That is not a hypothetical. This repo has already shipped a length table
 * holding 4 of 16 prefixes, so `.MICRO.` was read as metres -- a factor of a
 * million, applied silently to a real model.
 *
 * These cases therefore go through the PUBLIC path (`extractProjectUnits` on
 * a real STEP file), not a direct table read, so they also cover the dotted
 * `.MICRO.` spelling and the trimming around it, which is where a prefix is
 * actually resolved. The expected numbers below are written out from the SI
 * definitions -- never regenerate them from what the parser currently
 * returns, or the pin becomes a mirror.
 *
 * The stronger fix is to extend the shared vector file so BOTH resolvers are
 * pinned at once; that is left to the maintainer, since it is a Rust-side
 * change this branch cannot verify locally.
 */

/** Build source bytes + EntityIndex over a complete ISO-10303-21 file. */
function indexIfc(content: string): { source: Uint8Array; entityIndex: EntityIndex } {
  const source = new TextEncoder().encode(content);
  const byId = new Map<number, EntityRef>();
  const byType = new Map<string, number[]>();
  const re = /^#(\d+)=([A-Z0-9_]+)\(/;
  let offset = 0;
  let lineNumber = 0;
  for (const line of content.split('\n')) {
    lineNumber += 1;
    const m = re.exec(line);
    if (m) {
      const expressId = Number(m[1]);
      const type = m[2];
      byId.set(expressId, { expressId, type, byteOffset: offset, byteLength: line.length, lineNumber });
      const list = byType.get(type) ?? [];
      list.push(expressId);
      byType.set(type, list);
    }
    offset += line.length + 1; // +1 for '\n' (fixtures are pure ASCII)
  }
  return { source, entityIndex: { byId, byType } };
}

/** A minimal project whose only length unit is metres carrying `prefix`. */
function projectWithLengthPrefix(prefix: string): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4X3_ADD2'));",
    'ENDSEC;',
    'DATA;',
    "#1=IFCPROJECT('0001projectaaaaaaaaaaa',$,'P',$,$,$,$,$,#2);",
    '#2=IFCUNITASSIGNMENT((#3));',
    `#3=IFCSIUNIT(*,.LENGTHUNIT.,${prefix},.METRE.);`,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

/**
 * The SI prefixes, written from the BIPM definitions. `symbol` is the
 * prefixed metre as it should be displayed; `scale` converts a value in that
 * unit to metres.
 */
const SI_PREFIX_CASES: ReadonlyArray<{ prefix: string; symbol: string; scale: number }> = [
  { prefix: '.EXA.', symbol: 'Em', scale: 1e18 },
  { prefix: '.PETA.', symbol: 'Pm', scale: 1e15 },
  { prefix: '.TERA.', symbol: 'Tm', scale: 1e12 },
  { prefix: '.GIGA.', symbol: 'Gm', scale: 1e9 },
  { prefix: '.MEGA.', symbol: 'Mm', scale: 1e6 },
  { prefix: '.KILO.', symbol: 'km', scale: 1e3 },
  { prefix: '.HECTO.', symbol: 'hm', scale: 1e2 },
  { prefix: '.DECA.', symbol: 'dam', scale: 1e1 },
  { prefix: '.DECI.', symbol: 'dm', scale: 1e-1 },
  { prefix: '.CENTI.', symbol: 'cm', scale: 1e-2 },
  { prefix: '.MILLI.', symbol: 'mm', scale: 1e-3 },
  { prefix: '.MICRO.', symbol: 'µm', scale: 1e-6 },
  { prefix: '.NANO.', symbol: 'nm', scale: 1e-9 },
  { prefix: '.PICO.', symbol: 'pm', scale: 1e-12 },
  { prefix: '.FEMTO.', symbol: 'fm', scale: 1e-15 },
  { prefix: '.ATTO.', symbol: 'am', scale: 1e-18 },
];

describe('SI prefix scales resolve to their BIPM values', () => {
  for (const c of SI_PREFIX_CASES) {
    it(`${c.prefix} metre is ${c.scale} m`, () => {
      const { source, entityIndex } = indexIfc(projectWithLengthPrefix(c.prefix));
      const unit = extractProjectUnits(source, entityIndex).unitForMeasure('IfcLengthMeasure');
      expect(unit, `${c.prefix} produced no length unit`).not.toBeNull();
      expect(unit!.symbol).toBe(c.symbol);
      // Relative comparison: these span 36 orders of magnitude, so an
      // absolute epsilon would be meaningless at both ends of the range.
      expect(unit!.siScale! / c.scale).toBeCloseTo(1, 12);
    });
  }

  it('covers all sixteen SI prefixes', () => {
    // A prefix dropped from the table above would otherwise just stop being
    // tested, silently -- which is the failure this file exists to prevent.
    expect(SI_PREFIX_CASES).toHaveLength(16);
    expect(new Set(SI_PREFIX_CASES.map((c) => c.symbol)).size).toBe(16);
  });

  it('an unknown prefix falls back to unscaled metres, not to a wrong scale', () => {
    // The lookup ends in `?? 1.0`. That fallback is correct -- an unreadable
    // prefix must not silently scale -- but nothing exercised it, so a typo'd
    // table key would land here and look like plain metres.
    const { source, entityIndex } = indexIfc(projectWithLengthPrefix('.NOTAPREFIX.'));
    const unit = extractProjectUnits(source, entityIndex).unitForMeasure('IfcLengthMeasure');
    expect(unit).not.toBeNull();
    expect(unit!.siScale).toBe(1.0);
  });
});

describe('imperial length factors are the exact 1959 agreement values', () => {
  // International yard and pound agreement, 1959: 1 yard = 0.9144 m EXACTLY,
  // from which foot = 0.3048, inch = 0.0254, and mile = 1760 yd = 1609.344 m.
  // These are definitions, not measurements, so they are stated exactly.
  const EXPECTED: ReadonlyArray<[string, number]> = [
    ['FOOT', 0.3048],
    ['FEET', 0.3048],
    ['INCH', 0.0254],
    ['YARD', 0.9144],
    ['MILE', 1609.344],
  ];

  for (const [name, metres] of EXPECTED) {
    it(`${name} is ${metres} m`, () => {
      expect(CONVERSION_BASED_UNIT_FACTORS[name]).toBe(metres);
    });

    it(`quoted '${name}' matches the bare spelling`, () => {
      // IFC files carry the unit name as a quoted STEP string, so the table
      // holds both spellings. They are hand-kept in pairs, and only the bare
      // FOOT spelling is reached by any existing test -- so a typo in a
      // quoted entry would make exactly one spelling of one unit wrong.
      const quoted = CONVERSION_BASED_UNIT_FACTORS[`'${name}'`];
      if (quoted !== undefined) expect(quoted).toBe(metres);
    });
  }

  it('the derived factors stay consistent with the yard', () => {
    // foot = yard/3 and inch = yard/36 by definition, so a single mistyped
    // digit in any one of the three breaks this relation even if each value
    // still looks plausible on its own.
    const yard = CONVERSION_BASED_UNIT_FACTORS['YARD'];
    expect(CONVERSION_BASED_UNIT_FACTORS['FOOT']).toBeCloseTo(yard / 3, 15);
    expect(CONVERSION_BASED_UNIT_FACTORS['INCH']).toBeCloseTo(yard / 36, 15);
    expect(CONVERSION_BASED_UNIT_FACTORS['MILE']).toBeCloseTo(yard * 1760, 9);
  });
});
