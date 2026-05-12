/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { planeBasis, nearestCardinalAxis } from './section-plane-basis.ts';

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
