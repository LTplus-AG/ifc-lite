/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addTranslation, type Translation } from './translation.js';
import { rotateWorkspacePoint, radiansToDegrees } from './rotation.js';
import { alignTwoPoints, checkNeedsWarning, scaleRatioIsOff, type TwoPointAlignInput } from './two-point-align.js';

const near = (actual: number, expected: number, tolerance: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);

function solve(input: TwoPointAlignInput) {
  const result = alignTwoPoints(input);
  assert.ok(result.ok, 'expected an alignment');
  return result.alignment;
}

/** Build a reference pair by moving the model's own pair through a KNOWN
 * heading about A (via the shared `rotateWorkspacePoint`, the function the
 * placement itself uses) and a known move, so the expected answer does not come
 * from the code under test. */
function pairs(a: Translation, b: Translation, degrees: number, move: Translation): TwoPointAlignInput {
  const rotation = { angle: (degrees * Math.PI) / 180, pivot: a };
  return { a, b, aPrime: addTranslation(a, move), bPrime: addTranslation(rotateWorkspacePoint(b, rotation), move) };
}

/** The transform applied to a point, the way `ModelPlacement` applies it. */
function apply(point: Translation, alignment: ReturnType<typeof solve>): Translation {
  return addTranslation(rotateWorkspacePoint(point, { angle: alignment.heading, pivot: alignment.pivot }), alignment.delta);
}

describe('two-point align math (#11505)', () => {
  it('pure translation: heading 0, delta A->A\', check exact', () => {
    const alignment = solve(pairs([10, 20, 3], [40, 20, 3], 0, [5, -7, 0.5]));
    assert.equal(alignment.heading, 0);
    assert.deepEqual(alignment.delta, [5, -7, 0.5]);
    assert.deepEqual(alignment.pivot, [10, 20, 3]);
    near(alignment.check.distance, 0, 1e-12, 'distance');
    near(alignment.check.planRatio, 1, 1e-15, 'ratio');
    near(alignment.check.deltaZ, 0, 1e-15, 'deltaZ');
  });

  for (const degrees of [90, -30, 12.4, 179.9, -179.9, 135]) {
    it(`recovers ${degrees} degrees with the placement's own sign (positive = counter-clockwise from above)`, () => {
      const input = pairs([100, 200, 0], [130, 240, 2], degrees, [-12, 8, 1]);
      const alignment = solve(input);
      near(radiansToDegrees(alignment.heading), degrees, 1e-9, 'heading');
      // A lands on A', B on B' — through the real rotation function.
      const landedA = apply(input.a, alignment), landedB = apply(input.b, alignment);
      for (let i = 0; i < 3; i++) near(landedA[i], input.aPrime[i], 1e-9, `A[${i}]`);
      for (let i = 0; i < 3; i++) near(landedB[i], input.bPrime[i], 1e-9, `B[${i}]`);
      near(alignment.check.distance, 0, 1e-9, 'check');
    });
  }

  it('fixes the sign: +X turning to +Y is +90, not -90', () => {
    const alignment = solve({ a: [0, 0, 0], b: [1, 0, 0], aPrime: [0, 0, 0], bPrime: [0, 1, 0] });
    near(alignment.heading, Math.PI / 2, 1e-15, 'heading');
  });

  it('folds the half-turn onto +180 and never returns -180', () => {
    const alignment = solve({ a: [0, 0, 0], b: [1, 0, 0], aPrime: [0, 0, 0], bPrime: [-1, 0, 0] });
    assert.equal(alignment.heading, Math.PI);
    const nearly = solve({ a: [0, 0, 0], b: [1, 0, 0], aPrime: [0, 0, 0], bPrime: [-1, -1e-9, 0] });
    near(nearly.heading, -Math.PI, 1e-6, 'just past the half turn');
    assert.ok(nearly.heading > -Math.PI - 1e-12);
  });

  it('is exact at large coordinates (1e6 m): differences, not absolutes', () => {
    const base: Translation = [1_000_000, 2_000_000, 500];
    const b: Translation = [1_000_030, 2_000_040, 502];
    const input = pairs(base, b, -30, [250_000.123, -125_000.456, 0.25]);
    const alignment = solve(input);
    near(radiansToDegrees(alignment.heading), -30, 1e-7, 'heading');
    // Absolute coordinates carry ~2e-10 m of double rounding at this magnitude.
    near(alignment.check.distance, 0, 1e-6, 'check at 1e6');
    assert.deepEqual(alignment.delta, [input.aPrime[0] - base[0], input.aPrime[1] - base[1], input.aPrime[2] - base[2]]);
  });

  it('flags a unit/scale mismatch in the check and the ratio, not in the heading', () => {
    // The reference pair is 1000x longer (model in mm, reference in m).
    const alignment = solve({ a: [0, 0, 0], b: [3, 4, 0], aPrime: [0, 0, 0], bPrime: [3000, 4000, 0] });
    near(alignment.heading, 0, 1e-15, 'heading');
    near(alignment.check.planRatio, 0.001, 1e-12, 'ratio');
    assert.ok(alignment.check.distance > 4000, `B lands ${alignment.check.distance} m from B'`);
    assert.ok(checkNeedsWarning(alignment.check));
    assert.ok(scaleRatioIsOff(alignment.check));
  });

  it('a 0.05% length difference is within the ratio tolerance, 0.2% is not', () => {
    assert.ok(!scaleRatioIsOff(solve({ a: [0, 0, 0], b: [100, 0, 0], aPrime: [0, 0, 0], bPrime: [100.05, 0, 0] }).check));
    assert.ok(scaleRatioIsOff(solve({ a: [0, 0, 0], b: [100, 0, 0], aPrime: [0, 0, 0], bPrime: [100.2, 0, 0] }).check));
  });

  it('reports an elevation mismatch of the two segments, signed (reference minus moving)', () => {
    const alignment = solve({ a: [0, 0, 0], b: [10, 0, 1], aPrime: [0, 0, 0], bPrime: [10, 0, 1.5] });
    near(alignment.check.deltaZ, 0.5, 1e-15, 'deltaZ');
    near(alignment.check.distance, 0.5, 1e-12, 'distance counts the Z miss');
    assert.ok(checkNeedsWarning(alignment.check));
  });

  it('a 2 mm length difference shows as a 2 mm check and passes the threshold', () => {
    const alignment = solve({ a: [0, 0, 0], b: [10, 0, 0], aPrime: [0, 0, 0], bPrime: [10.002, 0, 0] });
    near(alignment.check.distance, 0.002, 1e-12, 'distance');
    assert.ok(!checkNeedsWarning(alignment.check));
  });

  it('a sideways miss is absorbed by the heading: the check measures length (and Z), not direction', () => {
    const alignment = solve({ a: [0, 0, 0], b: [10, 0, 0], aPrime: [0, 0, 0], bPrime: [10, 0.05, 0] });
    near(alignment.heading, Math.atan2(0.05, 10), 1e-15, 'heading follows B\'');
    assert.ok(alignment.check.distance < 2e-4);
  });

  it('refuses a pair that has no plan direction, naming which pair', () => {
    assert.deepEqual(alignTwoPoints({ a: [1, 1, 0], b: [1, 1, 5], aPrime: [0, 0, 0], bPrime: [9, 0, 0] }),
      { ok: false, reason: 'moving-pair-degenerate' });
    assert.deepEqual(alignTwoPoints({ a: [0, 0, 0], b: [9, 0, 0], aPrime: [4, 4, 0], bPrime: [4.0005, 4, 0] }),
      { ok: false, reason: 'reference-pair-degenerate' });
    assert.deepEqual(alignTwoPoints({ a: [0, 0, 0], b: [Number.NaN, 0, 0], aPrime: [0, 0, 0], bPrime: [9, 0, 0] }),
      { ok: false, reason: 'non-finite' });
  });
});
