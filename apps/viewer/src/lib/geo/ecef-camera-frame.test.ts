/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ecefCameraFrame } from './ecef-camera-frame.js';

/**
 * #2495 — the ECEF camera frame `cesium-bridge.syncCamera` writes into
 * `viewer.camera` every animation frame.
 *
 * The floor it replaced (`dirLen < 1e-8`) is the family #2489 / #2494 closed
 * inside `packages/renderer`: `Infinity < 1e-8` is false and `NaN < 1e-8` is
 * false, so both slipped past the bail-out that exists precisely to stop a
 * meaningless direction, and the division that followed wrote NaN into the
 * Cesium camera.
 */

const dot = (a: readonly number[], b: readonly number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: readonly number[]) => Math.hypot(a[0], a[1], a[2]);
const v = (x: number, y: number, z: number) => ({ x, y, z });

/** Component-wise closeness — `deepStrictEqual` would separate `-0` from `0`,
 *  which a cross product produces freely and which no consumer can observe. */
function assertVecClose(actual: readonly number[], expected: readonly number[], msg?: string) {
  for (let i = 0; i < 3; i++) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) < 1e-12,
      `${msg ?? 'vector'} component ${i}: ${actual[i]} !≈ ${expected[i]}`,
    );
  }
}

function assertOrthonormal(frame: NonNullable<ReturnType<typeof ecefCameraFrame>>) {
  for (const [name, axis] of Object.entries(frame)) {
    assert.ok(axis.every(Number.isFinite), `${name} is not finite: ${JSON.stringify(axis)}`);
    assert.ok(Math.abs(len(axis) - 1) < 1e-12, `${name} is not unit length: ${len(axis)}`);
  }
  assert.ok(Math.abs(dot(frame.direction, frame.up)) < 1e-12, 'direction ⟂ up');
  assert.ok(Math.abs(dot(frame.direction, frame.right)) < 1e-12, 'direction ⟂ right');
  assert.ok(Math.abs(dot(frame.up, frame.right)) < 1e-12, 'up ⟂ right');
}

describe('ecefCameraFrame — ordinary poses', () => {
  it('derives the right-handed frame from an ordinary pose', () => {
    const frame = ecefCameraFrame(v(0, 0, 0), v(10, 0, 0), v(0, 0, 1))!;
    assert.ok(frame);
    assertOrthonormal(frame);
    assertVecClose(frame.direction, [1, 0, 0]);
    assertVecClose(frame.up, [0, 0, 1]);
    assertVecClose(frame.right, [0, -1, 0]);
  });

  it('re-orthogonalises an up that is only approximately perpendicular', () => {
    // Real ECEF poses arrive with an up a few ulps off perpendicular; Cesium
    // rejects a non-orthogonal frame outright.
    const frame = ecefCameraFrame(v(0, 0, 0), v(10, 0, 0), v(0.2, 0, 1))!;
    assertOrthonormal(frame);
    assert.ok(frame.up[2] > 0.99, 'kept the requested up hemisphere');
  });

  it('handles genuine ECEF magnitudes (≈6.4e6 m) without any upper bound kicking in', () => {
    const frame = ecefCameraFrame(
      v(4_517_590.9, 837_996.4, 4_442_954.4),
      v(4_517_600.9, 838_006.4, 4_442_964.4),
      v(0.7, 0.13, 0.7),
    )!;
    assert.ok(frame, 'a real-world ECEF pose must survive');
    assertOrthonormal(frame);
  });
});

describe('ecefCameraFrame — non-finite and degenerate poses (#2495)', () => {
  it('rejects target ≡ position (the case the original floor was written for)', () => {
    assert.strictEqual(ecefCameraFrame(v(1, 2, 3), v(1, 2, 3), v(0, 0, 1)), null);
    assert.strictEqual(ecefCameraFrame(v(0, 0, 0), v(1e-12, 0, 0), v(0, 0, 1)), null);
  });

  for (const [label, pos, target] of [
    ['an infinite eye coordinate', v(Infinity, 0, 0), v(10, 0, 0)],
    ['an infinite target coordinate', v(0, 0, 0), v(Infinity, 0, 0)],
    ['both infinite (Infinity − Infinity = NaN)', v(Infinity, 0, 0), v(Infinity, 0, 0)],
    ['a NaN eye coordinate', v(NaN, 0, 0), v(10, 0, 0)],
    ['a NaN target coordinate', v(0, 0, 0), v(0, NaN, 0)],
  ] as Array<[string, { x: number; y: number; z: number }, { x: number; y: number; z: number }]>) {
    it(`rejects ${label} instead of writing NaN into the camera`, () => {
      assert.strictEqual(ecefCameraFrame(pos, target, v(0, 0, 1)), null);
    });
  }

  it('substitutes a basis when up is parallel to the view direction (the plan view)', () => {
    // The finite degeneracy no finiteness guard would ever catch: looking
    // straight down world Z with up still world Z makes `direction × up` the
    // zero vector, and normalising that is NaN.
    const frame = ecefCameraFrame(v(0, 0, 100), v(0, 0, 0), v(0, 0, 1))!;
    assert.ok(frame, 'a plan view must still produce a frame');
    assertOrthonormal(frame);
    assertVecClose(frame.direction, [0, 0, -1]);
  });

  it('substitutes a basis for a non-finite or zero up, keeping the real direction', () => {
    for (const bad of [v(Infinity, 0, 0), v(NaN, 0, 0), v(0, 0, 0)]) {
      const frame = ecefCameraFrame(v(0, 0, 0), v(10, 0, 0), bad)!;
      assert.ok(frame, `up=${JSON.stringify(bad)} must not lose the frame`);
      assertOrthonormal(frame);
      assertVecClose(frame.direction, [1, 0, 0], 'the usable direction is preserved');
    }
  });

  it('is deterministic: the same substituted pose gives a bit-identical frame', () => {
    // The frame is rewritten every animation frame; a substitute that varied
    // would spin the basemap while the user held still.
    const a = ecefCameraFrame(v(0, 0, 100), v(0, 0, 0), v(0, 0, 1))!;
    const b = ecefCameraFrame(v(0, 0, 100), v(0, 0, 0), v(0, 0, 1))!;
    assert.deepStrictEqual(a, b);
  });

  // Anti-mutation. The direction bail-out must stay a finiteness test plus the
  // 1e-8 floor it always had — widening the floor would silently drop
  // legitimate close-focus poses, which is exactly the failure mode a
  // magnitude-only reading of this guard produces.
  it('still accepts a short but perfectly valid view direction', () => {
    const frame = ecefCameraFrame(v(0, 0, 0), v(1e-6, 0, 0), v(0, 0, 1))!;
    assert.ok(frame, 'a 1µm view vector is short, not degenerate');
    assertOrthonormal(frame);
    assertVecClose(frame.direction, [1, 0, 0]);
  });

  it('still accepts a tiny but perfectly valid up vector', () => {
    const frame = ecefCameraFrame(v(0, 0, 0), v(10, 0, 0), v(0, 0, 1e-300))!;
    assert.ok(frame);
    assertOrthonormal(frame);
    assertVecClose(frame.up, [0, 0, 1], 'a tiny up still names the up hemisphere');
  });
});
