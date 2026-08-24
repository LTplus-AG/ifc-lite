/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { mutualNearestPairs } from './mutual-nearest.js';

describe('mutualNearestPairs', () => {
  it('never produces a pairing with a repeated base or head index (mutation-sweep finding)', () => {
    // A's nearest head is X (dist 1), but X's OWN nearest base is B (dist 0.5),
    // so A-X is NOT mutual. B's nearest head is also X — and X agrees — so
    // B-X is the mutual pair, and it retires in the first round. Only then
    // does A pair with the head left over, Y (dist 3).
    //
    // A greedy "does `from` have SOME nearest counterpart" check (dropping the
    // `nearestBase[h] === b` half of the mutuality test) accepts A-X purely
    // because A's own scan found X — without ever checking whether X agrees.
    // Confirmed by removing that check and running this exact fixture: the
    // function then returns TWO pairs, both claiming head index 0 (X) —
    // corrupting the 1:1 pairing this function's own doc promises ("Mutual
    // pairs ... are necessarily disjoint").
    const base: [number, number, number][] = [
      [0, 0, 0], // A
      [1.5, 0, 0], // B
    ];
    const head: [number, number, number][] = [
      [1, 0, 0], // X — B's true nearest (dist 0.5), not A's (dist 1)
      [3, 0, 0], // Y — what A is left with once B-X retires
    ];

    const pairs = mutualNearestPairs(base, head, 10, () => true);

    // Every base index and every head index appears in at most one pair.
    const baseIndices = pairs.map((p) => p.base);
    const headIndices = pairs.map((p) => p.head);
    expect(new Set(baseIndices).size).toBe(baseIndices.length);
    expect(new Set(headIndices).size).toBe(headIndices.length);

    // The concrete, correct answer: B claims its true nearest X first (it is
    // closer to X than A is), leaving A to pair with the only head left, Y —
    // even though A's naive first-choice was X.
    expect(pairs).toEqual([
      { base: 0, head: 1, distance: 3 },
      { base: 1, head: 0, distance: 0.5 },
    ]);
  });

  it('abstains (empty pairing) when every point is equidistant from every other — a symmetric layout has no unique nearest neighbour', () => {
    const base: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
    ];
    const head: [number, number, number][] = [
      [5, 0, 0],
      [5, 0, 0],
    ];

    const pairs = mutualNearestPairs(base, head, 100, () => true);
    expect(pairs).toEqual([]);
  });

  it('rejects a pair whose distance exceeds maxDistance even though it would otherwise be mutual', () => {
    const base: [number, number, number][] = [[0, 0, 0]];
    const head: [number, number, number][] = [[100, 0, 0]];

    const pairs = mutualNearestPairs(base, head, 10, () => true);
    expect(pairs).toEqual([]);
  });

  it('vetoes a pair via `accept` without disturbing the pool for later rounds', () => {
    const base: [number, number, number][] = [
      [0, 0, 0], // A
      [5, 0, 0], // B
    ];
    const head: [number, number, number][] = [
      [1, 0, 0], // X — A's nearest
      [4, 0, 0], // Y — B's nearest
    ];

    // Veto A-X specifically; B-Y should still be accepted independently.
    const pairs = mutualNearestPairs(base, head, 100, (b, h) => !(b === 0 && h === 0));

    expect(pairs).toEqual([{ base: 1, head: 1, distance: 1 }]);
  });
});
