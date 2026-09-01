/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #3490: `applyWhereFilter` tested only the FIRST same-named property (or
 * quantity) set. `duplicate-pset-lookup.test.ts` already covers the
 * existence-spread case (the property only lives on the second set); this
 * file covers the case #3490 actually reports — BOTH same-named sets carry
 * the requested property, with DIFFERENT values, and only the value on the
 * later set satisfies the `--where` operator. `findPropertyInSets` already
 * finds the property in that case (existence is not the bug); it returns
 * the FIRST same-named set's value, and `compareValues` tests only that
 * one, so the entity is wrongly excluded.
 *
 * A filter is a predicate over the entity: it should pass when ANY
 * same-named set satisfies the condition, not just the first one found.
 */

import { describe, expect, it } from 'vitest';
import { applyWhereFilter, parseWhereFilter } from './query.js';

/**
 * wallC: FIRST set REI30 (no match), SECOND set REI60 (matches) — the
 * exact shape from the issue.
 * wallD: neither set matches (REI30, REI45).
 * wallE: FIRST set already matches (REI60, REI90) — must keep working.
 */
const PROPS: Record<string, unknown[]> = {
  wallC: [
    { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI30' }] },
    { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI60' }] },
  ],
  wallD: [
    { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI30' }] },
    { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI45' }] },
  ],
  wallE: [
    { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI60' }] },
    { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI90' }] },
  ],
};

/** Same shape, on the quantity side ("Also make sure --where on a qset ..."). */
const QUANTITIES: Record<string, unknown[]> = {
  qtyC: [
    { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Width', value: 5 }] },
    { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Width', value: 9 }] },
  ],
  qtyD: [
    { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Width', value: 5 }] },
    { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Width', value: 6 }] },
  ],
};

const bim = {
  properties: (ref: string) => PROPS[ref] ?? [],
  quantities: (ref: string) => QUANTITIES[ref] ?? [],
};

const wallC = { ref: 'wallC', name: 'Wall C' };
const wallD = { ref: 'wallD', name: 'Wall D' };
const wallE = { ref: 'wallE', name: 'Wall E' };
const qtyC = { ref: 'qtyC', name: 'Qty C' };
const qtyD = { ref: 'qtyD', name: 'Qty D' };

describe('applyWhereFilter: two same-named psets carrying different values for the same property (#3490)', () => {
  it('returns an entity whose SECOND same-named set satisfies the filter, even though the first does not', () => {
    const parsed = parseWhereFilter('Pset_WallCommon.FireRating=REI60');
    expect(applyWhereFilter([wallC], parsed, bim).map(e => e.ref)).toEqual(['wallC']);
  });

  it('still returns an entity whose FIRST same-named set already satisfies the filter', () => {
    const parsed = parseWhereFilter('Pset_WallCommon.FireRating=REI60');
    expect(applyWhereFilter([wallE], parsed, bim).map(e => e.ref)).toEqual(['wallE']);
  });

  it('excludes an entity where NEITHER same-named set satisfies the filter', () => {
    const parsed = parseWhereFilter('Pset_WallCommon.FireRating=REI60');
    expect(applyWhereFilter([wallD], parsed, bim)).toEqual([]);
  });

  it('runs the same any-match across all three entities in one pass', () => {
    const parsed = parseWhereFilter('Pset_WallCommon.FireRating=REI60');
    expect(applyWhereFilter([wallC, wallD, wallE], parsed, bim).map(e => e.ref)).toEqual(['wallC', 'wallE']);
  });

  it('applies any-match to != too: passes when ANY same-named set differs, not only when EVERY set differs', () => {
    // wallC carries REI30 and REI60. Under any-match, the REI30 occurrence
    // alone satisfies `!= REI60`, so the wall passes even though its
    // second set equals REI60. This is the semantics chosen for #3490:
    // uniform any-match across every operator, matching the ANY-match
    // `matchesPsetFilter`/`matchesQsetFilter` already use for
    // `EntityQuery.whereProperty` in packages/query.
    const parsed = parseWhereFilter('Pset_WallCommon.FireRating!=REI60');
    expect(applyWhereFilter([wallC], parsed, bim).map(e => e.ref)).toEqual(['wallC']);
  });
});

describe('applyWhereFilter: two same-named qsets carrying different values for the same quantity (#3490)', () => {
  it('returns an entity whose SECOND same-named qset satisfies the filter', () => {
    const parsed = parseWhereFilter('Qto_WallBaseQuantities.Width=9');
    expect(applyWhereFilter([qtyC], parsed, bim).map(e => e.ref)).toEqual(['qtyC']);
  });

  it('excludes an entity where NEITHER same-named qset satisfies the filter', () => {
    const parsed = parseWhereFilter('Qto_WallBaseQuantities.Width=9');
    expect(applyWhereFilter([qtyD], parsed, bim)).toEqual([]);
  });
});
