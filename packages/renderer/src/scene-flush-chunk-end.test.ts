/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { computeFlushChunkEnd } from './scene.ts';

// Mirrors flushPending()'s real constants so the "always progresses" contract
// is checked against the shapes that actually occur, not toy numbers.
const MAX_INDICES_PER_APPEND = 300_000;

describe('computeFlushChunkEnd', () => {
  it('always takes at least one mesh past readIndex, even if the first mesh alone exceeds the volume cap', () => {
    // A single oversize mesh (splitMeshForStreaming is supposed to prevent
    // this upstream, but the chunker must not stall even if it didn't).
    const lengths = [MAX_INDICES_PER_APPEND * 10];
    const end = computeFlushChunkEnd((i) => lengths[i], 0, 1, MAX_INDICES_PER_APPEND);
    assert.strictEqual(end, 1);
  });

  it('stops before exceeding the volume cap once at least one mesh has been taken', () => {
    const lengths = [100, 100, 100, 100];
    const end = computeFlushChunkEnd((i) => lengths[i], 0, 4, 250);
    // 100 + 100 = 200 (<=250); + 100 = 300 (>250) -> stop before the 3rd mesh.
    assert.strictEqual(end, 2);
  });

  it('is bounded by hardEnd even when the volume cap is never hit', () => {
    const lengths = [1, 1, 1, 1, 1];
    const end = computeFlushChunkEnd((i) => lengths[i], 1, 3, MAX_INDICES_PER_APPEND);
    assert.strictEqual(end, 3);
  });

  it('never returns readIndex unchanged when hardEnd > readIndex, for any finite indices.length', () => {
    // This is the contract flushPending's zero-progress guard relies on: as
    // long as hardEnd > readIndex (guaranteed by the three invariants
    // documented at the call site in scene.ts), this helper always advances.
    for (const first of [0, 1, 100, 1e9]) {
      const lengths = [first, 5, 5];
      const end = computeFlushChunkEnd((i) => lengths[i], 0, 3, 1);
      assert.notStrictEqual(end, 0, `first=${first} produced zero progress`);
    }
  });

  it('closes the chunk at a NaN indices.length instead of silently making the volume cap vacuous', () => {
    // Regression for the second, separate fix: `chunkIndices + NaN > cap` is
    // `false` (NaN comparisons are always false), so a naive `> cap` check
    // would let the chunk keep growing all the way to hardEnd instead of
    // stopping. `computeFlushChunkEnd` is written as `!(... <= cap)` so NaN
    // forces a break instead of passing through unchecked.
    const lengths = [100, NaN, 100, 100, 100];
    const end = computeFlushChunkEnd((i) => lengths[i], 0, 5, 250);
    // Mesh 0 is always taken (100). Mesh 1 has NaN length: chunkIndices(100) +
    // NaN = NaN; the NaN-safe check must treat that as exceeding the cap and
    // break BEFORE taking mesh 1 -- not silently continue with a poisoned
    // chunkIndices total through to hardEnd.
    assert.strictEqual(end, 1);
  });

  it('closes the chunk at a -Infinity indices.length instead of letting the volume cap grow unbounded to hardEnd', () => {
    // Regression for a third, separate shape: a -Infinity `next` makes
    // `chunkIndices + next` collapse to -Infinity permanently (poisoning
    // every later `chunkIndices` too), so `!(chunkIndices + next <=
    // maxIndicesPerAppend)` is `!(true)` = false FOREVER -- the volume cap
    // never fires again and the chunk grows all the way to hardEnd,
    // regardless of how large hardEnd is. Every non-finite `next` (NaN,
    // +Infinity, -Infinity) must close the chunk instead of being folded
    // into the running total.
    const lengths = [100, -Infinity, 100, 100, 100];
    const end = computeFlushChunkEnd((i) => lengths[i], 0, 5, 250);
    assert.strictEqual(end, 1);
  });

  it('reproduces exactly today\'s cap semantics for all-finite input (mutation target: !(<=) vs >)', () => {
    // Every finite combination must behave identically whether the cap check
    // is written as `chunkIndices + next > cap` (old) or
    // `!(chunkIndices + next <= cap)` (new) -- they are logically equivalent
    // for non-NaN numbers. This test only passes if that equivalence holds;
    // it does not by itself prove the NaN case (see the test above for that).
    const cases: Array<{ lengths: number[]; readIndex: number; hardEnd: number; cap: number; expected: number }> = [
      { lengths: [50, 50, 50, 50], readIndex: 0, hardEnd: 4, cap: 100, expected: 2 },
      { lengths: [50, 50, 50, 50], readIndex: 0, hardEnd: 4, cap: 150, expected: 3 },
      { lengths: [10, 10, 10], readIndex: 1, hardEnd: 3, cap: 5, expected: 2 },
    ];
    for (const c of cases) {
      const end = computeFlushChunkEnd((i) => c.lengths[i], c.readIndex, c.hardEnd, c.cap);
      assert.strictEqual(end, c.expected, JSON.stringify(c));
    }
  });
});
