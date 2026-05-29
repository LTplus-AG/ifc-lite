/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { pickFitPolicy, type Bounds3 } from './camera-fit-policy.js';

const FOV_45 = (45 * Math.PI) / 180;

function bounds(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Bounds3 {
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

describe('pickFitPolicy', () => {
  describe('compact branch', () => {
    it('reproduces the legacy SE isometric pose for a unit-aspect bbox', () => {
      // 10x10x10 cube — aspect 1:1, deep compact territory. The pose has
      // to match the historical `fitToBounds()` formula 1:1 so building
      // models do not regress.
      const policy = pickFitPolicy(bounds(0, 0, 0, 10, 10, 10), { fovY: FOV_45 });
      expect(policy.kind).toBe('compact');
      expect(policy.aspect).toBe(1);
      // distance = maxSize * 2 = 20
      expect(policy.distance).toBeCloseTo(20, 5);
      // position = center + distance * (0.6, 0.5, 0.6)
      expect(policy.position.x).toBeCloseTo(5 + 20 * 0.6, 5);
      expect(policy.position.y).toBeCloseTo(5 + 20 * 0.5, 5);
      expect(policy.position.z).toBeCloseTo(5 + 20 * 0.6, 5);
      // target = bbox center
      expect(policy.target).toEqual({ x: 5, y: 5, z: 5 });
      expect(policy.up).toEqual({ x: 0, y: 1, z: 0 });
    });

    it('treats a moderately tall building (50x100x30) as compact', () => {
      // Aspect ~3.3:1, well below the linear threshold. Building models
      // typically fall in the 1:1 .. 10:1 range and must keep their
      // pose unchanged.
      const policy = pickFitPolicy(bounds(0, 0, 0, 50, 100, 30), { fovY: FOV_45 });
      expect(policy.kind).toBe('compact');
      expect(policy.distance).toBe(200); // maxSize=100, * 2
    });

    it('still picks compact for a flat slab (50x50x5) — aspect 10:1', () => {
      // Single-storey flat models are common; should NOT trigger the
      // linear branch.
      const policy = pickFitPolicy(bounds(0, 0, 0, 50, 5, 50), { fovY: FOV_45 });
      expect(policy.kind).toBe('compact');
      expect(policy.aspect).toBe(10);
    });
  });

  describe('linear branch', () => {
    it('switches to linear for the railway-fixture aspect (932:0.75)', () => {
      // The reporter's `linear-placement-of-signal.ifc` produces this
      // exact bbox shape post-RTC. Pre-fix this would auto-fit to ~1864 m
      // and every 1 m signal projected to ~0.4 px (invisible). The
      // policy must pick the linear branch.
      const policy = pickFitPolicy(
        bounds(-0.25, 0, -428, 932.59, 0.75, 0.25),
        { fovY: FOV_45, viewportShortPx: 664 },
      );
      expect(policy.kind).toBe('linear');
      // aspect = longest / shortest = 932.84 / 0.75 ≈ 1244
      expect(policy.aspect).toBeGreaterThan(1000);
      // distance must be a small fraction of the longest dim — the whole
      // point of the policy is to NOT recede to 2 * longest.
      expect(policy.distance).toBeLessThan(932.84 * 0.31);
      // and far enough that we're outside the bbox (cap is 30% of longest)
      expect(policy.distance).toBeGreaterThan(50);
    });

    it('targets the bbox centre (so user can pan along the alignment)', () => {
      const b = bounds(-0.25, 0, -428, 932.59, 0.75, 0.25);
      const policy = pickFitPolicy(b, { fovY: FOV_45 });
      expect(policy.target.x).toBeCloseTo(466.17, 1);
      expect(policy.target.y).toBeCloseTo(0.375, 2);
      expect(policy.target.z).toBeCloseTo(-213.875, 1);
    });

    it('looks down-and-along the longest axis', () => {
      // For a model whose longest axis is +X, the camera must sit at
      // -X-ish (so the alignment recedes into +X) with a slight +Y
      // elevation. Direction vector from position → target must point
      // primarily +X with a small +Y component.
      const policy = pickFitPolicy(
        bounds(0, 0, 0, 1000, 1, 50),
        { fovY: FOV_45 },
      );
      const dir = {
        x: policy.target.x - policy.position.x,
        y: policy.target.y - policy.position.y,
        z: policy.target.z - policy.position.z,
      };
      const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
      const dx = dir.x / len;
      const dy = dir.y / len;
      // Looking primarily +X (cos 20° ≈ 0.94), with downward tilt of -sin 20°.
      // Wait — view direction is (along * cos - up * sin), so position is
      // opposite: camera is BEHIND target along that vector. From the camera
      // we look forward along that same vector — so target - position points
      // in +X (along) and -Y (down). Verify both.
      expect(dx).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 3);
      expect(dy).toBeCloseTo(-Math.sin((20 * Math.PI) / 180), 3);
    });

    it('respects whichever axis is longest (Z-major)', () => {
      // Same shape but rotated 90°: longest axis is now Z. View direction
      // must follow.
      const policy = pickFitPolicy(
        bounds(0, 0, 0, 50, 1, 1000),
        { fovY: FOV_45 },
      );
      const dir = {
        x: policy.target.x - policy.position.x,
        z: policy.target.z - policy.position.z,
      };
      const len = Math.sqrt(dir.x * dir.x + dir.z * dir.z);
      expect(Math.abs(dir.x / len)).toBeLessThan(0.01); // negligible X
      expect(dir.z).toBeGreaterThan(0); // looking +Z
    });

    it('floors the feature size against pathological zero-thin bboxes', () => {
      // A 1000 × 0.0001 × 1 model — shortest dim is effectively zero,
      // would drive distance to ~zero if naively used. Policy must clamp.
      const policy = pickFitPolicy(
        bounds(0, 0, 0, 1000, 0.0001, 1),
        { fovY: FOV_45 },
      );
      expect(policy.kind).toBe('linear');
      // distance ought to land somewhere usable — not zero, not 2000.
      expect(policy.distance).toBeGreaterThan(1);
      expect(policy.distance).toBeLessThan(1000 * 0.31);
    });

    it('caps the linear distance at 30% of the longest axis', () => {
      // For an "okay" feature size that solves to a huge distance, the
      // cap keeps us inside a usable slice of the alignment.
      const policy = pickFitPolicy(
        bounds(0, 0, 0, 10_000, 100, 100),
        { fovY: FOV_45 },
      );
      expect(policy.kind).toBe('linear');
      expect(policy.distance).toBeLessThanOrEqual(10_000 * 0.3);
    });
  });

  it('honours an override threshold (so tests can pin the boundary)', () => {
    // Aspect 5:1 — normally compact. Force linear by lowering threshold.
    const b = bounds(0, 0, 0, 100, 20, 20);
    expect(pickFitPolicy(b, { fovY: FOV_45 }).kind).toBe('compact');
    expect(
      pickFitPolicy(b, { fovY: FOV_45, linearAspectThreshold: 4 }).kind,
    ).toBe('linear');
  });
});
