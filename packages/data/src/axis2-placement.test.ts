/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `firstProjAxis` is the TypeScript copy of the renderer's fill for an absent
 * `IfcAxis2Placement3D.RefDirection` (#5922). Every expected vector here is
 * also pinned against `build_axis2_matrix` in
 * `rust/geometry/tests/absent_ref_direction_fill.rs`.
 */

import { describe, it, expect } from 'vitest';
import { firstProjAxis } from './axis2-placement.js';

type V = [number, number, number];

function expectClose(actual: V, expected: V): void {
  for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i]!, 12);
}

function dot(a: V, b: V): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe('firstProjAxis (#5922)', () => {
  it('is world X for the default Axis and for an Axis already normal to X', () => {
    expectClose(firstProjAxis([0, 0, 1]), [1, 0, 0]);
    expectClose(firstProjAxis([0, 1, 0]), [1, 0, 0]);
    expectClose(firstProjAxis([0, 0, -3]), [1, 0, 0]);
  });

  it('projects world X onto the plane normal to a tilted Axis', () => {
    expectClose(firstProjAxis([1, 0, 1]), [Math.SQRT1_2, 0, -Math.SQRT1_2]);
  });

  it('is (0,1,0) for an Axis of exactly +X', () => {
    expectClose(firstProjAxis([1, 0, 0]), [0, 1, 0]);
    expectClose(firstProjAxis([4, 0, 0]), [0, 1, 0]);
  });

  it('is (0,-1,0) for an Axis of exactly -X, where the renderer takes (0,0,1) x Axis', () => {
    // World Y here would turn the frame 180 degrees about the Axis relative
    // to what the viewer draws, which is the compare bug #5922 reported.
    expectClose(firstProjAxis([-1, 0, 0]), [0, -1, 0]);
    expectClose(firstProjAxis([-2.5, 0, 0]), [0, -1, 0]);
  });

  it('projects world X for an Axis near X but outside the renderer tolerance', () => {
    // Projection length ~4e-5 > 1e-6: the renderer projects X, giving about
    // (0,-1,0) for a +Y offset on +X, and about (0,+1,0) for one on -X.
    for (const axis of [[1, 4e-5, 0], [-1, 4e-5, 0], [1, 0, -4e-5]] as V[]) {
      const x = firstProjAxis(axis);
      const n = Math.hypot(...axis);
      const z: V = [axis[0] / n, axis[1] / n, axis[2] / n];
      const p: V = [1 - z[0] * z[0], -z[0] * z[1], -z[0] * z[2]];
      const pn = Math.hypot(...p);
      expectClose(x, [p[0] / pn, p[1] / pn, p[2] / pn]);
      // `1 - z[0]^2` cancels to ~1.6e-9 here, so the renderer's arithmetic
      // (copied exactly) leaves the result ~1e-11 off perpendicular.
      expect(Math.abs(dot(x, z))).toBeLessThan(1e-10);
    }
    expect(firstProjAxis([1, 4e-5, 0])[1]).toBeLessThan(0);
    expect(firstProjAxis([-1, 4e-5, 0])[1]).toBeGreaterThan(0);
  });

  it('takes (0,0,1) x Axis for an Axis within the renderer tolerance of X', () => {
    // Projection length ~1e-7 <= 1e-6: the renderer switches, so a +Y
    // offset on +X gives about (0,+1,0), the opposite of the schema's
    // projection. Copied deliberately so readers match what is drawn.
    const nearPlus = firstProjAxis([1, 1e-7, 0]);
    expectClose(nearPlus, [-1e-7, 1, 0]);
    const nearMinus = firstProjAxis([-1, 1e-7, 0]);
    expectClose(nearMinus, [-1e-7, -1, 0]);
    expect(Math.abs(dot(nearPlus, [1, 1e-7, 0]))).toBeLessThan(1e-12);
  });

  it('reads a zero-length Axis as (0,0,1), as the renderer does', () => {
    expectClose(firstProjAxis([0, 0, 0]), [1, 0, 0]);
  });

  it('always returns a unit vector', () => {
    for (const axis of [[0.3, -0.2, 0.9], [-1, 1e-7, 1e-7], [1, 0, 0]] as V[]) {
      expect(Math.hypot(...firstProjAxis(axis))).toBeCloseTo(1, 14);
    }
  });
});
