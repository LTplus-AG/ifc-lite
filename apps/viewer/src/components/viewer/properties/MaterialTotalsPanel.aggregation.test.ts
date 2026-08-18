/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `pickQuantity`'s docstring on `MaterialTotalsPanel` promises: "Pick a
 * quantity value by candidate names (case-insensitive), else by type." The
 * volume call site implemented that fallback; the area and weight call
 * sites — built from the same `*ByName` maps in the same `qset.quantities`
 * loop — did not. An element whose only area (or weight) quantity carries a
 * vendor-specific name outside the IFC-standard candidate list (e.g.
 * "PerimeterArea", "TopArea") contributed zero to that material's total and
 * its row was hidden, while the identical situation for volume was counted.
 * This has been present since the file's first commit (#978).
 *
 * These tests drive `aggregateQuantitiesFromQsets` — the function extracted
 * from the three call sites so the "match a candidate name, else by type"
 * rule is applied identically to volume, area and weight instead of three
 * copies that can silently drift apart.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { QuantityType } from '@ifc-lite/data';
import { aggregateQuantitiesFromQsets } from './MaterialTotalsPanel.js';

type Qty = { name: string; type: number; value: number };
type Qset = { quantities: readonly Qty[] };

function qsets(quantities: Qty[]): Qset[] {
  return [{ quantities }];
}

describe('aggregateQuantitiesFromQsets', () => {
  describe('volume', () => {
    it('picks a candidate-named quantity (existing behaviour)', () => {
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'NetVolume', type: QuantityType.Volume, value: 12 }]),
      );
      assert.equal(r.volume, 12);
    });

    it('falls back to a non-candidate-named quantity of the same type (the fix)', () => {
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'CustomVendorVolume', type: QuantityType.Volume, value: 7 }]),
      );
      assert.equal(r.volume, 7);
    });

    it('is undefined when no volume quantity exists', () => {
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'NetArea', type: QuantityType.Area, value: 5 }]),
      );
      assert.equal(r.volume, undefined);
    });
  });

  describe('area', () => {
    it('picks a candidate-named quantity (existing behaviour)', () => {
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'NetArea', type: QuantityType.Area, value: 30 }]),
      );
      assert.equal(r.area, 30);
    });

    it('falls back to a non-candidate-named quantity of the same type (the fix)', () => {
      // RED against pre-fix code: the area call site had no else-by-type
      // fallback, so this returned undefined and the total stayed 0.
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'PerimeterArea', type: QuantityType.Area, value: 18 }]),
      );
      assert.equal(r.area, 18);
    });

    it('is undefined when no area quantity exists', () => {
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'NetVolume', type: QuantityType.Volume, value: 9 }]),
      );
      assert.equal(r.area, undefined);
    });
  });

  describe('weight', () => {
    it('picks a candidate-named quantity (existing behaviour)', () => {
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'NetWeight', type: QuantityType.Weight, value: 500 }]),
      );
      assert.equal(r.weight, 500);
    });

    it('falls back to a non-candidate-named quantity of the same type (the fix)', () => {
      // RED against pre-fix code: the weight call site had no else-by-type
      // fallback, so this returned undefined and the total stayed 0.
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'ShippingWeight', type: QuantityType.Weight, value: 250 }]),
      );
      assert.equal(r.weight, 250);
    });

    it('is undefined when no weight quantity exists', () => {
      const r = aggregateQuantitiesFromQsets(
        qsets([{ name: 'NetArea', type: QuantityType.Area, value: 4 }]),
      );
      assert.equal(r.weight, undefined);
    });
  });

  it('breaks ties among several non-candidate names deterministically (alphabetical)', () => {
    const r = aggregateQuantitiesFromQsets(
      qsets([
        { name: 'ZTopArea', type: QuantityType.Area, value: 99 },
        { name: 'APerimeterArea', type: QuantityType.Area, value: 11 },
      ]),
    );
    assert.equal(r.area, 11);
  });
});
