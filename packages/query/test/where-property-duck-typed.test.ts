/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `count` and `findByQuantity` are OPTIONAL members of the property/quantity
 * tables on `IfcStoreBase`, and @ifc-lite/data is published: stores written
 * against the interface before those members existed must keep working. These
 * pin what omitting them does.
 *
 * The `createMinimalStore` duck-typed store lives in
 * `where-property-fixtures.ts`; the STEP-vs-table behaviour it complements is
 * in `where-property-fallback.test.ts` and `where-property-parity.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { IfcTypeEnum } from '@ifc-lite/data';
import { createMinimalStore, runFilters } from './where-property-fixtures.js';

describe('whereProperty on duck-typed stores that omit the optional table members', () => {
  it('a table without `count` still answers through findByProperty', async () => {
    // `count` is new on this interface. Reading a missing `count` as zero would
    // route every store written against the older interface to the on-demand
    // fallback, silently returning [] for stores whose `findByProperty` works.
    const store = createMinimalStore({ withCount: false });
    const spy = vi.spyOn(store.properties, 'findByProperty');
    expect(await runFilters(store, IfcTypeEnum.IfcWall, [{ pset: 'Pset_WallCommon', prop: 'IsExternal', op: '=', value: true }])).toEqual([1]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a table reporting a count answers identically', async () => {
    const store = createMinimalStore({ withCount: true });
    expect(await runFilters(store, IfcTypeEnum.IfcWall, [{ pset: 'Pset_WallCommon', prop: 'IsExternal', op: '=', value: true }])).toEqual([1]);
  });

  it('a quantity table without findByQuantity is resolved per candidate instead', async () => {
    // Omitting the optional index must cost work, never correctness.
    const withoutIndex = createMinimalStore({ withCount: true, withFindByQuantity: false });
    const spy = vi.spyOn(withoutIndex, 'getQuantities');
    expect(await runFilters(withoutIndex, IfcTypeEnum.IfcWall, [{ pset: 'Qto_WallBaseQuantities', prop: 'Length', op: '>', value: 3 }])).toEqual([1]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    const withIndex = createMinimalStore({ withCount: true, withFindByQuantity: true });
    const spy2 = vi.spyOn(withIndex, 'getQuantities');
    expect(await runFilters(withIndex, IfcTypeEnum.IfcWall, [{ pset: 'Qto_WallBaseQuantities', prop: 'Length', op: '>', value: 3 }])).toEqual([1]);
    expect(spy2).not.toHaveBeenCalled();
    spy2.mockRestore();
  });

  // The two tables choose their strategy independently. A store can materialise
  // one and not the other, and deriving both from `properties.count` gets the
  // other one wrong in whichever direction it disagrees.
  it('resolves quantities per candidate when only the QUANTITY table is empty', async () => {
    // Populated property table beside an empty quantity index that still has
    // on-demand quantity data. Gating on `properties.count` would query the
    // empty index and match nothing.
    const store = createMinimalStore({
      withCount: true,
      withFindByQuantity: true,
      quantityCount: 0,
      emptyQuantityIndex: true,
    });
    const spy = vi.spyOn(store, 'getQuantities');

    expect(
      await runFilters(store, IfcTypeEnum.IfcWall, [{ pset: 'Qto_WallBaseQuantities', prop: 'Length', op: '>', value: 3 }]),
    ).toEqual([1]);
    expect(spy, 'an empty quantity index must not be trusted just because the property table is populated').toHaveBeenCalled();
    spy.mockRestore();
  });

  it('still uses the quantity index when only the PROPERTY table is empty', async () => {
    // The inverse: an empty property table must not drag a populated quantity
    // index onto the per-candidate path.
    const store = createMinimalStore({ withCount: false, withFindByQuantity: true, quantityCount: 2 });
    const spy = vi.spyOn(store, 'getQuantities');

    expect(
      await runFilters(store, IfcTypeEnum.IfcWall, [{ pset: 'Qto_WallBaseQuantities', prop: 'Length', op: '>', value: 3 }]),
    ).toEqual([1]);
    expect(spy, 'a populated quantity index must still answer even when the property table is empty').not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
