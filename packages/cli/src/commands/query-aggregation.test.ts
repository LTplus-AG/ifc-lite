/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `query-aggregation.ts` backs `ifc-lite query --sort` and had no test file.
 * Four separate mutations left the package's 271 tests green:
 *
 *   - inverting the quantity sort direction (`--desc` returned ascending),
 *   - dropping the camelCase attribute-key mapping (`--sort globalid` and
 *     `--sort objecttype` sorted every row by `undefined`, i.e. not at all),
 *   - swapping pset and property in a dotted `--sort Pset.Prop`, and
 *   - dropping the `|| 0` that turns an unparseable quantity into a number.
 *
 * Each branch of `sortEntities` is measured per-case: a two-element fixture
 * would be carried by one lucky comparison, so the fixtures below are ordered
 * so that *every* adjacent pair has to compare correctly.
 */

import { describe, expect, it } from 'vitest';
import { getQuantityValue, sortEntities, STANDARD_QTO_MAP } from './query-aggregation.js';

interface FakeEntity {
  ref: number;
  name?: string;
  type?: string;
  globalId?: string;
  objectType?: string;
}

/** Minimal stand-in for the SDK surface `sortEntities` actually touches. */
function fakeBim(
  quantities: Record<number, Array<{ name: string; quantities: Array<{ name: string; value: unknown }> }>> = {},
  properties: Record<number, Array<{ name: string; properties: Array<{ name: string; value: unknown }> }>> = {},
) {
  return {
    quantities: (ref: number) => quantities[ref] ?? [],
    properties: (ref: number) => properties[ref] ?? [],
  };
}

describe('getQuantityValue', () => {
  const bim = fakeBim({
    1: [
      { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 4.5 }] },
      { name: 'Qto_Custom', quantities: [{ name: 'Height', value: '3' }] },
    ],
    2: [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 'not a number' }] }],
  });

  it('finds a quantity in the first qset', () => {
    expect(getQuantityValue(bim, 1, 'Length')).toBe(4.5);
  });

  it('keeps searching past the first qset', () => {
    expect(getQuantityValue(bim, 1, 'Height')).toBe(3);
  });

  it('answers null — not 0 — when the quantity is absent', () => {
    // The distinction is load-bearing: `--sum` and `--sort` treat a missing
    // quantity differently from a present zero.
    expect(getQuantityValue(bim, 1, 'Volume')).toBeNull();
    expect(getQuantityValue(bim, 99, 'Length')).toBeNull();
  });

  it('answers 0, not NaN, for a present-but-unparseable value', () => {
    // Without the `|| 0`, this leaks NaN into `--sum` totals (NaN poisons the
    // whole sum) and into `--sort` comparisons (NaN comparisons are all false,
    // so the order silently becomes input order).
    const value = getQuantityValue(bim, 2, 'Length');
    expect(value).toBe(0);
    expect(Number.isNaN(value)).toBe(false);
  });
});

describe('sortEntities — quantity sort', () => {
  const entities: FakeEntity[] = [
    { ref: 3, name: 'C' },
    { ref: 1, name: 'A' },
    { ref: 4, name: 'D' },
    { ref: 2, name: 'B' },
  ];
  const bim = fakeBim({
    1: [{ name: 'Qto', quantities: [{ name: 'Area', value: 10 }] }],
    2: [{ name: 'Qto', quantities: [{ name: 'Area', value: 20 }] }],
    3: [{ name: 'Qto', quantities: [{ name: 'Area', value: 30 }] }],
    4: [{ name: 'Qto', quantities: [{ name: 'Area', value: 40 }] }],
  });

  it('sorts ascending by default', () => {
    expect(sortEntities(entities, 'Area', false, bim).map((e) => e.ref)).toEqual([1, 2, 3, 4]);
  });

  it('sorts descending when asked', () => {
    expect(sortEntities(entities, 'Area', true, bim).map((e) => e.ref)).toEqual([4, 3, 2, 1]);
  });

  it('treats a missing quantity as 0 rather than dropping the row', () => {
    const withMissing = [...entities, { ref: 9, name: 'Z' }];
    expect(sortEntities(withMissing, 'Area', false, bim).map((e) => e.ref)).toEqual([9, 1, 2, 3, 4]);
  });

  it('does not mutate the caller\'s array', () => {
    const input = [...entities];
    sortEntities(input, 'Area', true, bim);
    expect(input.map((e) => e.ref)).toEqual([3, 1, 4, 2]);
  });
});

describe('sortEntities — attribute sort', () => {
  const entities: FakeEntity[] = [
    { ref: 3, name: 'Charlie', type: 'IfcSlab', globalId: 'G3', objectType: 'OT-3' },
    { ref: 1, name: 'Alpha', type: 'IfcColumn', globalId: 'G1', objectType: 'OT-1' },
    { ref: 4, name: 'Delta', type: 'IfcWall', globalId: 'G4', objectType: 'OT-4' },
    { ref: 2, name: 'Bravo', type: 'IfcDoor', globalId: 'G2', objectType: 'OT-2' },
  ];
  const bim = fakeBim();

  it('sorts by name', () => {
    expect(sortEntities(entities, 'name', false, bim).map((e) => e.ref)).toEqual([1, 2, 3, 4]);
    expect(sortEntities(entities, 'name', true, bim).map((e) => e.ref)).toEqual([4, 3, 2, 1]);
  });

  it('sorts by type', () => {
    // IfcColumn < IfcDoor < IfcSlab < IfcWall
    expect(sortEntities(entities, 'type', false, bim).map((e) => e.ref)).toEqual([1, 2, 3, 4]);
  });

  it('maps the lowercase spelling back to the camelCase entity key', () => {
    // `globalid` and `objecttype` are accepted spellings, but the entity field
    // is `globalId` / `objectType`. Without the mapping every row reads
    // `undefined`, every comparison is 0, and the "sort" is a no-op that
    // silently returns input order.
    for (const spelling of ['globalId', 'globalid', 'GlobalId']) {
      expect(
        sortEntities(entities, spelling, false, bim).map((e) => e.ref),
        `--sort ${spelling}`,
      ).toEqual([1, 2, 3, 4]);
    }
    for (const spelling of ['objectType', 'objecttype', 'ObjectType']) {
      expect(
        sortEntities(entities, spelling, true, bim).map((e) => e.ref),
        `--sort ${spelling} --desc`,
      ).toEqual([4, 3, 2, 1]);
    }
  });

  it('puts entities missing the attribute first, ascending', () => {
    const withMissing = [...entities, { ref: 9 }];
    expect(sortEntities(withMissing, 'name', false, bim).map((e) => e.ref)).toEqual([9, 1, 2, 3, 4]);
  });
});

describe('sortEntities — dotted Pset.Prop sort', () => {
  const entities: FakeEntity[] = [
    { ref: 3 },
    { ref: 1 },
    { ref: 4 },
    { ref: 2 },
  ];
  // `Pset_WallCommon.Rating` and `Rating.Pset_WallCommon` must not be
  // interchangeable: the second name is looked up INSIDE the first.
  const properties = {
    1: [{ name: 'Pset_WallCommon', properties: [{ name: 'Rating', value: 10 }] }],
    2: [{ name: 'Pset_WallCommon', properties: [{ name: 'Rating', value: 20 }] }],
    3: [{ name: 'Pset_WallCommon', properties: [{ name: 'Rating', value: 30 }] }],
    4: [{ name: 'Pset_WallCommon', properties: [{ name: 'Rating', value: 40 }] }],
  };
  const bim = fakeBim({}, properties);

  it('reads the property from the named pset, in that order', () => {
    expect(sortEntities(entities, 'Pset_WallCommon.Rating', false, bim).map((e) => e.ref)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(sortEntities(entities, 'Pset_WallCommon.Rating', true, bim).map((e) => e.ref)).toEqual([
      4, 3, 2, 1,
    ]);
  });

  it('finds nothing when pset and property are given the wrong way round', () => {
    // The counter-example that pins the order: a reversed lookup finds no
    // values at all, so the comparison is flat and input order survives.
    expect(sortEntities(entities, 'Rating.Pset_WallCommon', false, bim).map((e) => e.ref)).toEqual([
      3, 1, 4, 2,
    ]);
  });

  it('falls back to quantity sets when the pset has no such property', () => {
    const qtoBim = fakeBim(
      {
        1: [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 5 }] }],
        2: [{ name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 1 }] }],
      },
      {},
    );
    expect(
      sortEntities([{ ref: 1 }, { ref: 2 }], 'Qto_WallBaseQuantities.Length', false, qtoBim).map(
        (e) => e.ref,
      ),
    ).toEqual([2, 1]);
  });

  it('compares non-numeric property values as text', () => {
    const textBim = fakeBim({}, {
      1: [{ name: 'Pset', properties: [{ name: 'Grade', value: 'C30' }] }],
      2: [{ name: 'Pset', properties: [{ name: 'Grade', value: 'A10' }] }],
      3: [{ name: 'Pset', properties: [{ name: 'Grade', value: 'B20' }] }],
    });
    expect(
      sortEntities([{ ref: 1 }, { ref: 2 }, { ref: 3 }], 'Pset.Grade', false, textBim).map(
        (e) => e.ref,
      ),
    ).toEqual([2, 3, 1]);
  });
});

describe('STANDARD_QTO_MAP', () => {
  it('names each type\'s standard quantity set with its real IFC spelling', () => {
    expect(Object.keys(STANDARD_QTO_MAP.IfcWall)).toEqual(['Qto_WallBaseQuantities']);
    expect(STANDARD_QTO_MAP.IfcWall.Qto_WallBaseQuantities).toContain('GrossSideArea');
    expect(STANDARD_QTO_MAP.IfcSpace.Qto_SpaceBaseQuantities).toContain('NetFloorArea');
  });

  it('lists exactly one standard qset per covered type', () => {
    for (const [type, sets] of Object.entries(STANDARD_QTO_MAP)) {
      expect(Object.keys(sets), type).toHaveLength(1);
      const [setName] = Object.keys(sets);
      expect(setName, type).toMatch(/^Qto_\w+BaseQuantities$/);
      expect(sets[setName].length, `${type}.${setName}`).toBeGreaterThanOrEqual(1);
    }
  });
});
