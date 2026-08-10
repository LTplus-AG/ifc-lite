/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { planeBasis, nearestCardinalAxis } from './section-plane-basis.js';

const EPS = 1e-6;
const dot = (a: readonly number[], b: readonly number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);

function assertOrthonormal(
  normal: readonly [number, number, number],
  label: string,
): void {
  const { tangent, bitangent } = planeBasis(normal);
  assert.ok(Math.abs(dot(tangent, normal)) < EPS,
    `${label}: tangent · normal must be ~0, got ${dot(tangent, normal)}`);
  assert.ok(Math.abs(dot(bitangent, normal)) < EPS,
    `${label}: bitangent · normal must be ~0, got ${dot(bitangent, normal)}`);
  assert.ok(Math.abs(dot(tangent, bitangent)) < EPS,
    `${label}: tangent · bitangent must be ~0, got ${dot(tangent, bitangent)}`);
  assert.ok(Math.abs(len(tangent)   - 1) < EPS, `${label}: |tangent|=1`);
  assert.ok(Math.abs(len(bitangent) - 1) < EPS, `${label}: |bitangent|=1`);
}

describe('planeBasis', () => {
  it('produces an orthonormal basis for the cardinal axes', () => {
    assertOrthonormal([1, 0, 0],  'normal=+X');
    assertOrthonormal([0, 1, 0],  'normal=+Y');
    assertOrthonormal([0, 0, 1],  'normal=+Z');
    assertOrthonormal([-1, 0, 0], 'normal=-X');
    assertOrthonormal([0, -1, 0], 'normal=-Y');
    assertOrthonormal([0, 0, -1], 'normal=-Z');
  });

  it('produces an orthonormal basis for tilted normals', () => {
    const tilts: Array<[number, number, number]> = [
      [0.5, 0.5, Math.SQRT1_2],
      [Math.SQRT1_2, 0, Math.SQRT1_2],
      [0.1, 0.99, 0.05],   // near-vertical — exercises the X-fallback branch
      [-0.3, -0.6, 0.74],
      [Math.SQRT1_2, Math.SQRT1_2, 0],
    ];
    for (const t of tilts) {
      const l = len(t);
      assertOrthonormal([t[0] / l, t[1] / l, t[2] / l], `tilt ${t.join(',')}`);
    }
  });

  it('is deterministic — same normal yields identical basis', () => {
    // The cap hatch must not rotate when the renderer rebuilds the basis,
    // so this contract is load-bearing.
    const a = planeBasis([0.6, 0.5, 0.62]);
    const b = planeBasis([0.6, 0.5, 0.62]);
    assert.deepStrictEqual(a, b);
  });

  it('is sign-stable around the +Y / -Y boundary', () => {
    // The reference-axis switch (Y vs X) happens at |ny| = 0.9. Stepping
    // through the boundary should not produce a NaN or zero-length basis.
    for (let nyStep = 0.85; nyStep <= 0.95; nyStep += 0.01) {
      const ny = nyStep;
      const nx = Math.sqrt(Math.max(0, 1 - ny * ny));
      assertOrthonormal([nx, ny, 0], `near-Y ny=${ny.toFixed(2)}`);
    }
  });
});

/**
 * `planeBasis` is total: every input yields a finite, unit, orthonormal pair
 * (#2489).
 *
 * It used to read the caller's magnitudes directly, so each of its magnitude
 * tests answered a question about LENGTH while its comment claimed an ANGLE.
 * A non-finite component passed both (`Infinity > 1e-9` is true, `NaN < 1e-9`
 * is false) and came back as an all-NaN pair — which the section gizmo writes
 * into a vertex buffer and the cap renderer uses to lift 2D cut polygons back
 * to 3D. Normalising the normal first is what makes the tests angular.
 *
 * Every assertion here is on the returned VALUES. A "does not throw" test
 * would pass on the broken code: NaN never throws, it just draws nothing.
 */
describe('planeBasis is total (#2489)', () => {
  /**
   * Compare bases by value. Cross products routinely produce `-0` where the
   * literal spelling is `0`, and `deepStrictEqual` treats those as different
   * while no consumer of an axis can; `+ 0` folds `-0` onto `0` and leaves
   * every other value alone.
   */
  const plain = (b: { tangent: readonly number[]; bitangent: readonly number[] }) => ({
    tangent: b.tangent.map((v) => v + 0),
    bitangent: b.bitangent.map((v) => v + 0),
  });
  const sameBasis = (
    actual: ReturnType<typeof planeBasis>,
    expected: { tangent: readonly number[]; bitangent: readonly number[] },
    label?: string,
    // node:assert's typed overload takes `Error | AssertMessageFunction`, not a
    // bare string, once the `expected` argument is narrowed. Wrap so the label
    // still reaches the failure output.
  ) => assert.deepStrictEqual(plain(actual), plain(expected), label === undefined ? undefined : new Error(label));

  /** What a normal with no usable direction degrades to: the horizontal plane. */
  const DEGENERATE = planeBasis([0, 1, 0]);

  it('degrades an Infinity component instead of returning NaN axes', () => {
    sameBasis(planeBasis([Infinity, 0, 0]), DEGENERATE);
    sameBasis(planeBasis([0, -Infinity, 0]), DEGENERATE);
  });

  it('degrades a NaN component', () => {
    sameBasis(planeBasis([NaN, 0, 0]), DEGENERATE);
    sameBasis(planeBasis([0, 0, NaN]), DEGENERATE);
  });

  it('degrades a mixed NaN + Infinity normal', () => {
    // `Math.hypot(Infinity, NaN, 0)` is Infinity, not NaN — the length test
    // has to reject both ends of the range, not just the NaN one.
    sameBasis(planeBasis([Infinity, NaN, 0]), DEGENERATE);
  });

  it('degrades a finite normal whose magnitude overflows', () => {
    sameBasis(planeBasis([1.7e308, 1.7e308, 0]), DEGENERATE);
  });

  it('degrades the zero normal to a UNIT pair, not a zero bitangent', () => {
    // The zero normal always reached the tangent fallback, but the bitangent
    // was then `cross(tangent, [0,0,0])` = `[0,0,0]` — a documented-unit axis
    // that was not unit, silently collapsing the cap's 2D→3D lift.
    sameBasis(planeBasis([0, 0, 0]), DEGENERATE);
    assertOrthonormal([0, 0, 0], 'zero normal');
  });

  it('returns a fresh mutable pair each call', () => {
    // `PlaneBasis` exposes mutable tuples and this is a public export, so the
    // degenerate answer must not be a shared constant a caller can corrupt.
    const a = planeBasis([NaN, 0, 0]);
    a.tangent[0] = 99;
    assert.strictEqual(planeBasis([NaN, 0, 0]).tangent[0], DEGENERATE.tangent[0]);
  });

  it('still resolves a short but perfectly valid normal', () => {
    // Anti-mutation. `[1e-12, 0, 0]` points cleanly along +X; only its length
    // is small. The pre-#2489 code declared it degenerate — its `1e-9` floor
    // was on the cross product's LENGTH, which scales with the normal's — and
    // returned a zero bitangent. An over-broad floor reintroduced anywhere in
    // this function fails here rather than passing quietly.
    assertOrthonormal([1e-12, 0, 0], 'tiny +X');
    sameBasis(planeBasis([1e-12, 0, 0]), planeBasis([1, 0, 0]));
  });

  it('routes a non-unit normal by its ANGLE to Y, not its length', () => {
    // `[10, 1, 0]` is 6 degrees off horizontal, nowhere near the |ny| = 0.9
    // near-vertical case the X-fallback exists for — but `|ny| = 1 >= 0.9`
    // sent it down that branch anyway, flipping the hatch axis 180 degrees
    // purely because the caller had not normalised. The docstring always
    // described this threshold as an angle; now it is one.
    const l = Math.hypot(10, 1, 0);
    sameBasis(planeBasis([10, 1, 0]), planeBasis([10 / l, 1 / l, 0]));
    assertOrthonormal([10, 1, 0], 'non-unit 6deg-off-horizontal');
  });

  it('leaves the basis for a unit normal unchanged', () => {
    // The guard is a gate on unusable input, not a change to the derivation:
    // the cap hatch must not rotate for any normal callers actually pass.
    sameBasis(planeBasis([0, 1, 0]),  { tangent: [0, 0, -1], bitangent: [1, 0, 0] });
    sameBasis(planeBasis([1, 0, 0]),  { tangent: [0, 0, 1],  bitangent: [0, 1, 0] });
    sameBasis(planeBasis([0, 0, -1]), { tangent: [1, 0, 0],  bitangent: [0, 1, 0] });
  });
});

describe('nearestCardinalAxis', () => {
  it('maps cardinal normals back to themselves with the right flip flag', () => {
    assert.deepStrictEqual(nearestCardinalAxis([0,  1,  0]), { axis: 'down',  flipped: false });
    assert.deepStrictEqual(nearestCardinalAxis([0, -1,  0]), { axis: 'down',  flipped: true  });
    assert.deepStrictEqual(nearestCardinalAxis([1,  0,  0]), { axis: 'side',  flipped: false });
    assert.deepStrictEqual(nearestCardinalAxis([-1, 0,  0]), { axis: 'side',  flipped: true  });
    assert.deepStrictEqual(nearestCardinalAxis([0,  0,  1]), { axis: 'front', flipped: false });
    assert.deepStrictEqual(nearestCardinalAxis([0,  0, -1]), { axis: 'front', flipped: true  });
  });

  it('picks the dominant cardinal axis for tilted normals', () => {
    // Mostly down-pointing → 'down', flipped (negative Y).
    assert.deepStrictEqual(
      nearestCardinalAxis([0.2, -0.95, 0.1]),
      { axis: 'down', flipped: true },
    );
    // Mostly +X → 'side'.
    assert.deepStrictEqual(
      nearestCardinalAxis([0.9, 0.3, 0.1]),
      { axis: 'side', flipped: false },
    );
    // Mostly +Z → 'front'.
    assert.deepStrictEqual(
      nearestCardinalAxis([0.1, 0.2, 0.97]),
      { axis: 'front', flipped: false },
    );
  });
});
