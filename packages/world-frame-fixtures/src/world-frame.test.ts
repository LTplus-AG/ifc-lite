/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Self-tests for the world-frame corpus: prove the four cases really place
 * THE SAME element, that the far offset contaminates ONLY the offset axis
 * (the sharpness property the corpus exists for), and that the
 * normal-projected noise bound is offset-invariant for an orthogonal normal.
 * A fixture whose own frame arithmetic is wrong would "catch" defects that
 * do not exist and miss ones that do.
 */

import { describe, expect, it } from 'vitest';
import {
  WORLD_FRAME_CASES,
  WORLD_FRAME_OFFSET_M,
  bakedWorldPositions,
  boxTriangles,
  normalProjectedNoiseBound,
  placeWorldFrame,
  quadTriangles,
  translateWorld,
  ulp32,
  worldAabb,
} from './index.js';

const LOCAL_BOX = boxTriangles([0, 0, 0], [3, 0.3, 2.7]);

describe('world-frame corpus placements', () => {
  it('all four cases place the same element (world AABBs agree up to offset-axis f32 noise)', () => {
    const reference = worldAabb(placeWorldFrame(LOCAL_BOX.positions, { frameCase: 'at-origin' }));
    for (const frameCase of WORLD_FRAME_CASES) {
      const placed = placeWorldFrame(LOCAL_BOX.positions, { frameCase });
      const far = frameCase === 'far-baked' || frameCase === 'far-local-frame';
      const box = worldAabb(placed);
      for (let a = 0; a < 3; a++) {
        const off = far && a === 0 ? WORLD_FRAME_OFFSET_M : 0;
        // The offset axis of a far placement may carry f32 quantization noise
        // (that noise is the point of the corpus). A local-frame re-base also
        // carries one f32 rounding of the small LOCAL values on every axis
        // (~1e-7 here) — small precisely because it scales with the element,
        // not with the world magnitude. Baked non-offset axes are exact.
        const rebase = placed.origin ? 1e-6 : 0;
        const tol = far && a === 0 ? ulp32(WORLD_FRAME_OFFSET_M) + rebase : rebase;
        expect(Math.abs(box.min[a]! - (reference.min[a]! + off))).toBeLessThanOrEqual(tol);
        expect(Math.abs(box.max[a]! - (reference.max[a]! + off))).toBeLessThanOrEqual(tol);
      }
    }
  });

  it('far-baked leaves the non-offset axes bit-identical to at-origin (sharpness property)', () => {
    // The corpus catches max-over-axes tolerances precisely because the far
    // offset perturbs nothing on the axes actually under test. If this ever
    // breaks, a far-case test failure could be honest noise instead of the
    // defect class.
    const near = placeWorldFrame(LOCAL_BOX.positions, { frameCase: 'at-origin' });
    const far = placeWorldFrame(LOCAL_BOX.positions, { frameCase: 'far-baked' });
    for (let i = 0; i < near.positions.length; i++) {
      if (i % 3 === 0) continue; // offset axis (x): allowed to differ
      expect(far.positions[i]).toBe(near.positions[i]);
    }
  });

  it('local-frame cases carry a non-zero origin and re-based positions', () => {
    const placed = placeWorldFrame(LOCAL_BOX.positions, { frameCase: 'local-frame' });
    expect(placed.origin).toBeDefined();
    // Router convention: origin = element AABB centre, so the re-based local
    // AABB is centred on zero.
    const local = worldAabb({ positions: placed.positions });
    for (let a = 0; a < 3; a++) {
      expect(local.min[a]! + local.max[a]!).toBeCloseTo(0, 5);
    }
    expect(placed.origin).toEqual([1.5, 0.15, 1.35]);
  });

  it('translateWorld moves the world box by the delta in BOTH frames, and only the origin in the local frame', () => {
    const delta: [number, number, number] = [5, 0, 0];
    for (const frameCase of WORLD_FRAME_CASES) {
      const placed = placeWorldFrame(LOCAL_BOX.positions, { frameCase });
      const moved = translateWorld(placed, delta);
      const before = worldAabb(placed);
      const after = worldAabb(moved);
      for (let a = 0; a < 3; a++) {
        // 5 m is exactly representable and small against the offset, so the
        // translation itself introduces no fresh f32 noise on these values.
        expect(after.min[a]! - before.min[a]!).toBeCloseTo(delta[a]!, 9);
      }
      if (placed.origin) {
        expect(moved.positions).toBe(placed.positions); // the #2529 trigger
      }
    }
  });

  it('normalProjectedNoiseBound ignores the offset axis for an orthogonal normal', () => {
    // A Z-normal bound must not grow because the model sits 10 km out in X:
    // the Z extents are identical across the corpus, so the bound is too.
    // This is the expected tolerance shape (PR #2622) stated as an equality.
    const zNormal: [number, number, number] = [0, 0, 1];
    const near = placeWorldFrame(LOCAL_BOX.positions, { frameCase: 'at-origin' });
    const far = placeWorldFrame(LOCAL_BOX.positions, { frameCase: 'far-baked' });
    expect(normalProjectedNoiseBound(zNormal, [far])).toBe(normalProjectedNoiseBound(zNormal, [near]));
    // ...while an X normal DOES see the far magnitude (that axis really is noisy).
    const xNormal: [number, number, number] = [1, 0, 0];
    expect(normalProjectedNoiseBound(xNormal, [far])).toBeGreaterThan(
      normalProjectedNoiseBound(xNormal, [near]),
    );
  });

  it('quadTriangles builds the plane the normal names', () => {
    const quad = quadTriangles('z', 0.4, 2);
    for (let i = 2; i < quad.positions.length; i += 3) {
      expect(quad.positions[i]).toBe(0.4);
    }
    expect(quad.indices).toHaveLength(6);
  });

  it('normalProjectedNoiseBound is invariant under negating a normal component (the |n_i| in the formula matters)', () => {
    // Both prior normal cases here (zNormal, xNormal) use only non-negative
    // components, so a mutant that drops Math.abs() around each n_i term
    // survives them undetected. The doc comment is explicit that the sum is
    // over |n_i|, not n_i: a negative-component normal must give the SAME
    // bound as its positive mirror, never a smaller (or negative) one.
    const far = placeWorldFrame(LOCAL_BOX.positions, { frameCase: 'far-baked' });

    // A normal with a non-zero component on EVERY axis. Negating only X (the
    // first version of this test) leaves the Y and Z terms multiplied by
    // |0| = 0, so dropping Math.abs() from either of those two terms still
    // passed. Each axis is negated on its own below, so all three terms are
    // pinned independently rather than only the one that happens to be set.
    const AXIS: [number, number, number] = [0.5, 0.5, Math.SQRT1_2];
    const bound = normalProjectedNoiseBound(AXIS, [far]);
    expect(bound).toBeGreaterThan(0);

    for (const axis of [0, 1, 2] as const) {
      const flipped: [number, number, number] = [...AXIS];
      flipped[axis] = -flipped[axis];
      expect(
        normalProjectedNoiseBound(flipped, [far]),
        `negating component ${axis} must not change the bound`,
      ).toBe(bound);
    }

    // All three at once, so a mutant that drops Math.abs() from every term
    // (rather than one) cannot hide behind the single-axis cases either.
    expect(normalProjectedNoiseBound([-AXIS[0], -AXIS[1], -AXIS[2]], [far])).toBe(bound);
  });

  it('bakedWorldPositions folds origin into each axis without shifting axes', () => {
    // Exercises the axis-indexed fold directly: this is the buffer a
    // consumer with no origin concept (e.g. the clash Mesh, in a sibling
    // package) actually ingests, and this corpus's own suite never called
    // it before — an axis-misindexed fold (origin[x] added to position.y,
    // etc.) passed every other test here undetected.
    const local = placeWorldFrame(LOCAL_BOX.positions, { frameCase: 'at-origin' });
    const placed = placeWorldFrame(LOCAL_BOX.positions, {
      frameCase: 'far-local-frame',
      offsetAxis: 'x',
    });
    const baked = bakedWorldPositions(placed);
    const bakedMin: [number, number, number] = [Infinity, Infinity, Infinity];
    const bakedMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < baked.length; i += 3) {
      for (let a = 0 as 0 | 1 | 2; a < 3; a++) {
        const c = baked[i + a]!;
        if (c < bakedMin[a]) bakedMin[a] = c;
        if (c > bakedMax[a]) bakedMax[a] = c;
      }
    }
    const bakedAabb = { min: bakedMin, max: bakedMax };
    const reference = worldAabb(local);
    // X carries both the far offset and rebase noise; Y and Z must fold
    // exactly (rebase noise only, no offset — the offset axis is X).
    for (const a of [1, 2] as const) {
      expect(Math.abs(bakedAabb.min[a]! - reference.min[a]!)).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(bakedAabb.max[a]! - reference.max[a]!)).toBeLessThanOrEqual(1e-6);
    }
    // X pinned to its exact expected placement, at the same tolerance as Y and
    // Z above. A `toBeGreaterThanOrEqual(WORLD_FRAME_OFFSET_M)` bound only
    // proves X is far from the origin, so a doubled or otherwise wrong
    // positive offset would satisfy it just as well.
    expect(Math.abs(bakedAabb.min[0]! - (reference.min[0]! + WORLD_FRAME_OFFSET_M)))
      .toBeLessThanOrEqual(1e-6);
    expect(Math.abs(bakedAabb.max[0]! - (reference.max[0]! + WORLD_FRAME_OFFSET_M)))
      .toBeLessThanOrEqual(1e-6);
  });
});
