/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The volume rules the split/merge detector rests on (issue #1891).
 *
 * The asymmetry is the thing under test: completeness is required to CONFIRM
 * and not required to REFUTE. Every case here is chosen to separate those two.
 */

import { describe, expect, it } from 'vitest';
import { findSingleInterloper, judgeVolumes, usableVolume } from './split-merge-evidence.js';

const TOL = 0.03;

describe('usableVolume', () => {
  it('accepts a positive finite number', () => {
    expect(usableVolume(2.5)).toBe(2.5);
  });

  it('refuses everything that is not one', () => {
    // Zero is the dangerous one: a proved-empty solid does not exist, but a
    // zero summed into a total silently makes a claim look better than it is.
    for (const value of [0, -1, Number.NaN, Infinity, -Infinity, undefined]) {
      expect(usableVolume(value)).toBeUndefined();
    }
  });
});

describe('judgeVolumes — confirmation needs completeness', () => {
  it('confirms a complete set inside the band', () => {
    const verdict = judgeVolumes(10, [3, 3, 4], TOL);
    expect(verdict.kind).toBe('confirmed');
    expect(verdict.complete).toBe(true);
    expect(verdict.piecesVolume).toBe(10);
    expect(verdict.residual).toBe(0);
  });

  it('measures the band against the WHOLE, not against the sum', () => {
    // 103.09 is +3.09% of the whole and only +2.997% of the sum, so the two
    // normalisations disagree — and normalising by the sum would let a set that
    // overshoots quietly widen its own target. Deliberately off the exact
    // boundary: `10.3 - 10` is `0.3000000000000007` in binary floating point, so
    // a test pinned to the edge would be measuring the FPU, not the rule.
    expect(judgeVolumes(100, [102.9], TOL).kind).toBe('confirmed');
    expect(judgeVolumes(100, [103.09], TOL).kind).toBe('refuted');
  });

  it('refuses to confirm when one piece is unmeasured, even though the rest fit', () => {
    // The sum of what is known lands on the nose, which is exactly the trap: a
    // sum missing a term is not a sum, and the unknown could be anything.
    const verdict = judgeVolumes(10, [3, 3, 4, undefined], TOL);
    expect(verdict.kind).toBe('unknown');
    expect(verdict.complete).toBe(false);
  });

  it('says nothing at all when the WHOLE is unmeasured', () => {
    const verdict = judgeVolumes(undefined, [3, 3, 4], TOL);
    expect(verdict.kind).toBe('unknown');
    expect(verdict.wholeVolume).toBeUndefined();
  });

  it('ignores a zero or negative volume exactly as if it were absent', () => {
    // Not "sums to 10 anyway": the set is INCOMPLETE, because a non-positive
    // number is not a measurement of a solid.
    expect(judgeVolumes(10, [3, 3, 4, 0], TOL).kind).toBe('unknown');
    expect(judgeVolumes(0, [3, 3, 4], TOL).kind).toBe('unknown');
  });
});

describe('judgeVolumes — refutation works on a partial sum', () => {
  it('refutes when the KNOWN volumes alone already overrun the whole', () => {
    // The asymmetry, stated: an unknown can only add, so nothing it could turn
    // out to be brings the total back down.
    const verdict = judgeVolumes(10, [8, 5, undefined, undefined], TOL);
    expect(verdict.kind).toBe('refuted');
    expect(verdict.complete).toBe(false);
  });

  it('does NOT refute an incomplete set that merely undershoots', () => {
    // The mirror image, and the reason the rule is one-directional: the missing
    // pieces are exactly what could account for the gap.
    expect(judgeVolumes(10, [3, undefined], TOL).kind).toBe('unknown');
  });

  it('refutes a complete set that undershoots', () => {
    // With nothing left unmeasured there is no candidate for the missing
    // material, so the shortfall is a real one.
    const verdict = judgeVolumes(10, [3, 3], TOL);
    expect(verdict.kind).toBe('refuted');
    expect(verdict.residual).toBeCloseTo(-0.4, 10);
  });
});

describe('findSingleInterloper', () => {
  it('finds the one piece whose own volume is the overshoot', () => {
    expect(findSingleInterloper(10, [4, 3, 3, 2], TOL)).toBe(3);
  });

  it('abstains when two pieces both explain it', () => {
    // Overshoot 2, and two pieces of 2. Which one is the foreign object? The
    // question has no answer, and this is precisely where a subset search would
    // start inventing one.
    expect(findSingleInterloper(10, [6, 2, 2, 2], TOL)).toBeUndefined();
  });

  it('abstains when nothing explains it', () => {
    expect(findSingleInterloper(10, [5, 5, 5], TOL)).toBeUndefined();
  });

  it('does not fire on a set that is already within tolerance', () => {
    // 10.1 against 10 is inside the 3% band, so there is nothing to repair —
    // and the 0.1 piece is close enough to the 0.1 overshoot to be mistaken for
    // the explanation by an implementation that skipped this guard. It would
    // then drop a legitimate small piece out of a set that was already right.
    //
    // (An UNDERSHOOT needs no test: a piece volume is positive by construction,
    // so it can never be within tolerance of a negative overshoot, and no
    // mutation of this function can make it fire. A guard that cannot fail is
    // not worth a test that cannot fail.)
    expect(findSingleInterloper(10, [5, 5, 0.1], TOL)).toBeUndefined();
  });

  it('refuses to reduce a set to a 1:1 pair', () => {
    // Overshoot 5, explained by the 5. Excluding it would leave one piece and
    // one whole, which is the content pass's question, already asked and
    // answered before this stage ever ran.
    expect(findSingleInterloper(10, [10, 5], TOL)).toBeUndefined();
  });

  it('is capped at ONE exclusion', () => {
    // Two foreign objects of 2 and 3 overshoot by 5, and no single piece is 5,
    // so nothing is repaired. Allowing a second exclusion would put the
    // combinatorics — and the non-uniqueness the whole design refuses — back.
    expect(findSingleInterloper(10, [5, 5, 2, 3], TOL)).toBeUndefined();
  });
});
