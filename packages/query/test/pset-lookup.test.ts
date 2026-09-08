/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { findPropertyInSets, findQuantityInSets } from '../src/pset-lookup.js';

/**
 * Real property values are heterogeneous (a boolean `IsExternal` alongside a
 * string `FireRating`), so the fixtures need this annotation: left to
 * inference, each set literal gets its OWN value type and the array becomes a
 * union that cannot unify with the helper's single `P`.
 */
type PropSets = { name: string; properties: { name: string; value: string | boolean }[] }[];
type QtoSets = { name: string; quantities: { name: string; value: number }[] }[];

describe('findPropertyInSets', () => {
  it('finds a property that only exists on the SECOND same-named set', () => {
    const sets: PropSets = [
      { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] },
      { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'REI60' }] },
    ];

    const result = findPropertyInSets(sets, 'Pset_WallCommon', 'FireRating');

    expect(result?.value).toBe('REI60');
  });

  it('returns undefined when no same-named set has the property', () => {
    const sets: PropSets = [
      { name: 'Pset_WallCommon', properties: [{ name: 'IsExternal', value: true }] },
      { name: 'Pset_WallCommon', properties: [{ name: 'LoadBearing', value: false }] },
    ];

    expect(findPropertyInSets(sets, 'Pset_WallCommon', 'FireRating')).toBeUndefined();
  });

  it('prefers the first matching set when both carry the property', () => {
    const sets: PropSets = [
      { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'first' }] },
      { name: 'Pset_WallCommon', properties: [{ name: 'FireRating', value: 'second' }] },
    ];

    expect(findPropertyInSets(sets, 'Pset_WallCommon', 'FireRating')?.value).toBe('first');
  });
});

describe('findQuantityInSets', () => {
  it('finds a quantity that only exists on the SECOND same-named set', () => {
    const sets: QtoSets = [
      { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 3 }] },
      { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'GrossVolume', value: 12.5 }] },
    ];

    const result = findQuantityInSets(sets, 'Qto_WallBaseQuantities', 'GrossVolume');

    expect(result?.value).toBe(12.5);
  });

  it('returns undefined when no same-named set has the quantity', () => {
    const sets: QtoSets = [
      { name: 'Qto_WallBaseQuantities', quantities: [{ name: 'Length', value: 3 }] },
    ];

    expect(findQuantityInSets(sets, 'Qto_WallBaseQuantities', 'GrossVolume')).toBeUndefined();
  });
});
