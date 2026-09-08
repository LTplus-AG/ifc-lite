/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Mutation-sweep finding: `UNIT_ALTERNATIVES` is a hand-typed lookup table of
 * scale/offset constants, and until this file existed only three of its
 * thirteen unit-type entries (LENGTHUNIT, VOLUMETRICFLOWRATEUNIT,
 * THERMODYNAMICTEMPERATUREUNIT) were exercised by any test — and even those
 * only through a couple of their options. A ten-times-wrong `ft2` scale
 * (0.9290304 instead of 0.09290304) survived the full `lib/units` suite
 * before this file existed — exactly the "a unit table with a missing/wrong
 * entry" shape #1573's own georeference sibling shipped (`.MICRO.` read as
 * metres, 1,000,000x wrong, silently).
 *
 * Every scale/offset here is checked against an INDEPENDENTLY derived value
 * (SI definitions / NIST conversion factors), never copied from
 * `alternatives.ts` itself — a self round-trip cannot see the source is
 * wrong.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UNIT_ALTERNATIVES, alternativesForUnitType, type UnitOption } from './alternatives.js';

const EPS = 1e-9;

function assertClose(actual: number, expected: number, label: string, eps = EPS) {
  assert.ok(Math.abs(actual - expected) < eps, `${label}: expected ~${expected}, got ${actual}`);
}

/** id -> {scale, offset} independently derived (not from alternatives.ts). */
const EXPECTED: Record<string, Record<string, { scale: number; offset?: number }>> = {
  LENGTHUNIT: {
    m: { scale: 1 },
    mm: { scale: 1e-3 },
    cm: { scale: 1e-2 },
    km: { scale: 1e3 },
    ft: { scale: 0.3048 }, // international foot, exact
    in: { scale: 0.0254 }, // international inch, exact
  },
  AREAUNIT: {
    m2: { scale: 1 },
    cm2: { scale: 1e-2 ** 2 },
    mm2: { scale: 1e-3 ** 2 },
    ft2: { scale: 0.3048 ** 2 },
    in2: { scale: 0.0254 ** 2 },
  },
  VOLUMEUNIT: {
    m3: { scale: 1 },
    l: { scale: 1e-3 },
    cm3: { scale: 1e-2 ** 3 },
    ft3: { scale: 0.3048 ** 3 },
    gal: { scale: 0.003785411784 }, // US liquid gallon, exact by definition
  },
  MASSUNIT: {
    kg: { scale: 1 },
    g: { scale: 1e-3 },
    t: { scale: 1e3 },
    lb: { scale: 0.45359237 }, // international avoirdupois pound, exact
  },
  TIMEUNIT: {
    s: { scale: 1 },
    min: { scale: 60 },
    h: { scale: 3600 },
    d: { scale: 86400 },
  },
  PLANEANGLEUNIT: {
    rad: { scale: 1 },
    deg: { scale: Math.PI / 180 },
  },
  VOLUMETRICFLOWRATEUNIT: {
    m3s: { scale: 1 },
    m3h: { scale: 1 / 3600 },
    ls: { scale: 1e-3 },
    lmin: { scale: 1e-3 / 60 },
    cfm: { scale: 0.3048 ** 3 / 60 }, // ft³/min
  },
  MASSFLOWRATEUNIT: {
    kgs: { scale: 1 },
    kgh: { scale: 1 / 3600 },
    gs: { scale: 1e-3 },
  },
  PRESSUREUNIT: {
    pa: { scale: 1 },
    kpa: { scale: 1e3 },
    mpa: { scale: 1e6 },
    bar: { scale: 1e5 },
    hpa: { scale: 100 },
    psi: { scale: 4.4482216152605 / 0.0254 ** 2 }, // lbf / in²
  },
  POWERUNIT: {
    w: { scale: 1 },
    kw: { scale: 1e3 },
    mw: { scale: 1e6 },
    hp: { scale: (550 * 0.3048 * 4.4482216152605) }, // 550 ft*lbf/s, mechanical hp
  },
  ENERGYUNIT: {
    j: { scale: 1 },
    kj: { scale: 1e3 },
    mj: { scale: 1e6 },
    wh: { scale: 3600 },
    kwh: { scale: 3.6e6 },
  },
  LINEARVELOCITYUNIT: {
    ms: { scale: 1 },
    kmh: { scale: 1000 / 3600 },
    fts: { scale: 0.3048 },
    mph: { scale: (1609.344 / 3600) }, // international mile / hour
  },
  FREQUENCYUNIT: {
    hz: { scale: 1 },
    khz: { scale: 1e3 },
    mhz: { scale: 1e6 },
  },
  THERMODYNAMICTEMPERATUREUNIT: {
    // siBase(K) = value*scale + offset
    k: { scale: 1, offset: 0 },
    c: { scale: 1, offset: 273.15 },
    // K = F*5/9 + (273.15 - 32*5/9)
    f: { scale: 5 / 9, offset: 273.15 - (32 * 5) / 9 },
  },
  MASSDENSITYUNIT: {
    kgm3: { scale: 1 },
    gcm3: { scale: 1000 }, // 1 g/cm3 = 1000 kg/m3
    gl: { scale: 1 }, // 1 g/L = 1 kg/m3
  },
  FORCEUNIT: {
    n: { scale: 1 },
    kn: { scale: 1e3 },
    lbf: { scale: 4.4482216152605 }, // pound-force, exact
  },
};

describe('UNIT_ALTERNATIVES scale/offset values (independently derived)', () => {
  for (const [unitType, expectedOptions] of Object.entries(EXPECTED)) {
    describe(unitType, () => {
      const actual = alternativesForUnitType(unitType);

      it('declares exactly the expected option ids (no missing / extra entry)', () => {
        assert.deepStrictEqual(
          actual.map((o) => o.id).sort(),
          Object.keys(expectedOptions).sort(),
        );
      });

      for (const [id, expected] of Object.entries(expectedOptions)) {
        it(`"${id}" scale${expected.offset !== undefined ? '/offset' : ''} matches the independently derived value`, () => {
          const opt = actual.find((o) => o.id === id);
          assert.ok(opt, `expected an option with id "${id}"`);
          assertClose(opt!.scale, expected.scale, `${unitType}.${id}.scale`, Math.max(EPS, Math.abs(expected.scale) * 1e-9));
          assertClose(opt!.offset ?? 0, expected.offset ?? 0, `${unitType}.${id}.offset`);
        });
      }
    });
  }

  it('covers every unit-type key actually present in UNIT_ALTERNATIVES (no untested table added later)', () => {
    assert.deepStrictEqual(Object.keys(UNIT_ALTERNATIVES).sort(), Object.keys(EXPECTED).sort());
  });
});

describe('UNIT_ALTERNATIVES structural invariants', () => {
  for (const [unitType, options] of Object.entries(UNIT_ALTERNATIVES)) {
    it(`${unitType}: first option is the SI base (scale 1, no non-zero offset) — "reset to file units" relies on this`, () => {
      const first = options[0];
      assert.strictEqual(first.scale, 1, `${unitType}'s first option must be the SI base (scale 1)`);
      assert.strictEqual(first.offset ?? 0, 0, `${unitType}'s first option must carry no offset`);
    });

    it(`${unitType}: option ids are unique`, () => {
      const ids = options.map((o: UnitOption) => o.id);
      assert.strictEqual(new Set(ids).size, ids.length, `duplicate id within ${unitType}`);
    });

    it(`${unitType}: option symbols are unique`, () => {
      const symbols = options.map((o: UnitOption) => o.symbol);
      assert.strictEqual(new Set(symbols).size, symbols.length, `duplicate symbol within ${unitType}`);
    });
  }
});

describe('alternativesForUnitType', () => {
  it('returns [] for an unrecognized unit-type token', () => {
    assert.deepStrictEqual(alternativesForUnitType('NOT_A_REAL_UNIT_TYPE'), []);
  });
});
