/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { MutablePropertyView } from '../src/index.js';
import { QuantityType } from '@ifc-lite/data';

describe('MutablePropertyView non-finite quantity round trip (#3596/#3611 shape)', () => {
  it('a non-finite per-quantity value survives exportMutations -> importMutations', () => {
    // `JSON.stringify` maps NaN/Infinity/-Infinity to `null` (RFC 8259 has no
    // non-finite numeric literal). `applyMutations`' quantity replay then does
    // `Number(mutation.newValue)`, and `Number(null)` is `0` — so an
    // out-of-range quantity silently became 0 across the round trip even
    // though direct application (no serialization in between) preserves it.
    for (const value of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, NaN]) {
      const a = new MutablePropertyView(null, 'm1');
      a.setQuantity(42, 'Qto_WallBaseQuantities', 'NetVolume', value, QuantityType.Volume);

      const json = a.exportMutations();
      const b = new MutablePropertyView(null, 'm1');
      b.importMutations(json);

      expect(b.getQuantitiesForEntity(42)).toEqual(a.getQuantitiesForEntity(42));
    }
  });

  it('a non-finite value in a whole-set CREATE_QUANTITY payload survives the round trip', () => {
    const a = new MutablePropertyView(null, 'm1');
    a.createQuantitySet(42, 'Qto_WallBaseQuantities', [
      { name: 'NetVolume', value: Number.POSITIVE_INFINITY, quantityType: QuantityType.Volume },
      { name: 'GrossArea', value: 12, quantityType: QuantityType.Area },
    ]);

    const json = a.exportMutations();
    const b = new MutablePropertyView(null, 'm1');
    b.importMutations(json);

    expect(b.getQuantitiesForEntity(42)).toEqual(a.getQuantitiesForEntity(42));
  });

  it('control: an ordinary finite quantity value still round-trips unchanged', () => {
    const a = new MutablePropertyView(null, 'm1');
    a.setQuantity(42, 'Qto_WallBaseQuantities', 'NetVolume', 3.5, QuantityType.Volume);

    const json = a.exportMutations();
    const b = new MutablePropertyView(null, 'm1');
    b.importMutations(json);

    expect(b.getQuantitiesForEntity(42)).toEqual(a.getQuantitiesForEntity(42));
    expect(json).not.toContain('__nonFiniteNumber');
  });

  it('control: a literal string property value is never mistaken for a non-finite-number marker', () => {
    // Guards the replacer/reviver scoping: only a raw *number* newValue/oldValue/
    // value is ever wrapped, so a string property whose text happens to be
    // "Infinity" must round-trip as that exact string, not as a number.
    const a = new MutablePropertyView(null, 'm1');
    a.setProperty(7, 'Pset_Custom', 'Note', 'Infinity');

    const json = a.exportMutations();
    const b = new MutablePropertyView(null, 'm1');
    b.importMutations(json);

    const value = b.getForEntity(7)
      .find(p => p.name === 'Pset_Custom')
      ?.properties.find(p => p.name === 'Note')?.value;
    expect(value).toBe('Infinity');
  });
});
