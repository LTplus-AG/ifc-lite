/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * An entity can legitimately carry two distinct property (or quantity)
 * sets that share one name -- e.g. "Pset_WallCommon" once from the type
 * definition and once from the occurrence. The `query` command's helpers
 * used to resolve such a set with `props.find((p: any) => p.name === ...)`,
 * which only ever sees the FIRST one: a `--where` filter silently excluded
 * an entity whose property lived on the second set, and `--sort` on a
 * dotted path sorted it as if it had no value at all.
 *
 * The typed `(p: any) =>` parameter is why these sites outlived the sweep
 * that converted every other one: `check-pset-name-find.mjs` matched only a
 * bare arrow parameter, so it reported the whole repo clean while these
 * stood. The helpers now go through `findPropertyInSets` /
 * `findQuantityInSets`, which scan every same-named set.
 *
 * `bim` is faked rather than parsed from IFC because these helpers touch it
 * only through `properties(ref)` / `quantities(ref)`; the equivalent
 * end-to-end path over a real duplicate-pset file is covered by
 * `headless-backend-duplicate-pset-filter.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { applyWhereFilter, parseWhereFilter } from './query.js';
import { sortEntities } from './query-aggregation.js';

/** Wall A carries Pset_WallCommon twice; only the SECOND has FireRating. */
const PROPS: Record<string, unknown[]> = {
  wallA: [
    { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] },
    { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI60' }] },
  ],
  wallB: [
    { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI30' }] },
  ],
};

/** Wall A carries Qto_WallBaseQuantities twice; only the SECOND has Width. */
const QUANTITIES: Record<string, unknown[]> = {
  wallA: [
    { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 4 }] },
    { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Width', value: 9 }] },
  ],
  wallB: [
    { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Width', value: 1 }] },
  ],
};

const bim = {
  properties: (ref: string) => PROPS[ref] ?? [],
  quantities: (ref: string) => QUANTITIES[ref] ?? [],
};

const wallA = { ref: 'wallA', name: 'Wall A' };
const wallB = { ref: 'wallB', name: 'Wall B' };

describe('applyWhereFilter with two same-named property sets', () => {
  it('keeps an entity whose filtered property lives on the second same-named pset', () => {
    const parsed = parseWhereFilter('Pset_WallCommon.FireRating=REI60');
    expect(applyWhereFilter([wallA, wallB], parsed, bim).map(e => e.ref)).toEqual(['wallA']);
  });

  it('keeps it for an existence filter too', () => {
    const parsed = parseWhereFilter('Pset_WallCommon.FireRating');
    expect(applyWhereFilter([wallA, wallB], parsed, bim).map(e => e.ref)).toEqual(['wallA', 'wallB']);
  });

  it('still excludes an entity where no same-named set carries the property', () => {
    const parsed = parseWhereFilter('Pset_WallCommon.LoadBearing');
    expect(applyWhereFilter([wallA, wallB], parsed, bim)).toEqual([]);
  });
});

describe('sortEntities on a dotted path spread across two same-named sets', () => {
  it('sorts by a property that lives on the second same-named pset', () => {
    const sorted = sortEntities([wallB, wallA], 'Pset_WallCommon.FireRating', false, bim);
    expect(sorted.map(e => e.ref)).toEqual(['wallB', 'wallA']);
  });

  it('sorts by a quantity that lives on the second same-named qset', () => {
    const sorted = sortEntities([wallA, wallB], 'Qto_WallBaseQuantities.Width', false, bim);
    expect(sorted.map(e => e.ref)).toEqual(['wallB', 'wallA']);
  });
});
