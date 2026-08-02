/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { pickFitPolicy, type Bounds3 } from './camera-fit-policy.js';

const FOV_45 = (45 * Math.PI) / 180;

function bounds(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): Bounds3 {
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } };
}

function assertCloseTo(actual: number, expected: number, digits: number, message?: string): void {
  const tolerance = 0.5 * 10 ** -digits;
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    message ?? `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

describe('pickFitPolicy', () => {
  describe('compact branch', () => {
    it('reproduces the legacy SE isometric pose for a unit-aspect bbox', () => {
      // 10x10x10 cube — aspect 1:1, deep compact territory. The pose has
      // to match the historical `fitToBounds()` formula 1:1 so building
      // models do not regress.
      const policy = pickFitPolicy(bounds(0, 0, 0, 10, 10, 10), { fovY: FOV_45 });
      assert.strictEqual(policy.kind, 'compact');
      assert.strictEqual(policy.aspect, 1);
      // distance = maxSize * 2 = 20
      assertCloseTo(policy.distance, 20, 5);
      // position = center + distance * (0.6, 0.5, 0.6)
      assertCloseTo(policy.position.x, 5 + 20 * 0.6, 5);
      assertCloseTo(policy.position.y, 5 + 20 * 0.5, 5);
      assertCloseTo(policy.position.z, 5 + 20 * 0.6, 5);
      // target = bbox center
      assert.deepStrictEqual(policy.target, { x: 5, y: 5, z: 5 });
      assert.deepStrictEqual(policy.up, { x: 0, y: 1, z: 0 });
    });

    it('treats a moderately tall building (50x100x30) as compact', () => {
      // Aspect ~3.3:1, well below the linear threshold. Building models
      // typically fall in the 1:1 .. 10:1 range and must keep their
      // pose unchanged.
      const policy = pickFitPolicy(bounds(0, 0, 0, 50, 100, 30), { fovY: FOV_45 });
      assert.strictEqual(policy.kind, 'compact');
      assert.strictEqual(policy.distance, 200); // maxSize=100, * 2
    });

    it('still picks compact for a flat slab (50x50x5) — aspect 10:1', () => {
      // Single-storey flat models are common; should NOT trigger the
      // linear branch.
      const policy = pickFitPolicy(bounds(0, 0, 0, 50, 5, 50), { fovY: FOV_45 });
      assert.strictEqual(policy.kind, 'compact');
      assert.strictEqual(policy.aspect, 10);
    });

    it('keeps a small high-aspect element compact (single rebar, issue #1350)', () => {
      // A 4.86 m × 0.084 m × 0.037 m reinforcing bar viewed alone — aspect
      // ~131:1, well past the linear threshold, but only metres long. The
      // linear "look down the axis from inside the bbox" pose framed it
      // end-on and it rendered as nothing. The absolute size floor must keep
      // it compact so the SE-isometric pose shows the whole bar.
      const policy = pickFitPolicy(
        bounds(2005.06, 5961.1, 25.5, 2005.097, 5961.184, 30.36),
        { fovY: FOV_45 },
      );
      assert.strictEqual(policy.kind, 'compact');
      assert.ok(policy.aspect > 100, `aspect ${policy.aspect} should exceed 100`);
      // distance = longest * 2; longest ≈ 4.86, so ≈ 9.72 — a normal
      // see-the-whole-bar framing, not an inside-the-bbox linear pose.
      assert.ok(
        policy.distance > 9 && policy.distance < 11,
        `distance ${policy.distance} should be ~2x the 4.86 m length`,
      );
    });

    it('honours the linearMinLongest floor override', () => {
      // 80 m × 1 m × 1 m — aspect 80, above the aspect threshold but below
      // the 100 m default size floor → compact. Lowering the floor to 50 m
      // lets it cross into linear.
      const b = bounds(0, 0, 0, 80, 1, 1);
      assert.strictEqual(pickFitPolicy(b, { fovY: FOV_45 }).kind, 'compact');
      assert.strictEqual(
        pickFitPolicy(b, { fovY: FOV_45, linearMinLongest: 50 }).kind,
        'linear',
      );
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
      assert.strictEqual(policy.kind, 'linear');
      // aspect = longest / shortest = 932.84 / 0.75 ≈ 1244
      assert.ok(policy.aspect > 1000, `aspect ${policy.aspect} should exceed 1000`);
      // distance must be a small fraction of the longest dim — the whole
      // point of the policy is to NOT recede to 2 * longest.
      assert.ok(policy.distance < 932.84 * 0.31, `distance ${policy.distance} should stay under 30% of longest`);
      // and far enough that we're outside the bbox (cap is 30% of longest)
      assert.ok(policy.distance > 50, `distance ${policy.distance} should exceed 50`);
    });

    it('targets the bbox centre (so user can pan along the alignment)', () => {
      const b = bounds(-0.25, 0, -428, 932.59, 0.75, 0.25);
      const policy = pickFitPolicy(b, { fovY: FOV_45 });
      assertCloseTo(policy.target.x, 466.17, 1);
      assertCloseTo(policy.target.y, 0.375, 2);
      assertCloseTo(policy.target.z, -213.875, 1);
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
      assertCloseTo(dx, Math.cos((20 * Math.PI) / 180), 3);
      assertCloseTo(dy, -Math.sin((20 * Math.PI) / 180), 3);
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
      assert.ok(Math.abs(dir.x / len) < 0.01, 'X component should be negligible');
      assert.ok(dir.z > 0, 'should be looking +Z');
    });

    it('floors the feature size against pathological zero-thin bboxes', () => {
      // A 1000 × 0.0001 × 1 model — shortest dim is effectively zero,
      // would drive distance to ~zero if naively used. Policy must clamp.
      const policy = pickFitPolicy(
        bounds(0, 0, 0, 1000, 0.0001, 1),
        { fovY: FOV_45 },
      );
      assert.strictEqual(policy.kind, 'linear');
      // distance ought to land somewhere usable — not zero, not 2000.
      assert.ok(policy.distance > 1, `distance ${policy.distance} should exceed 1`);
      assert.ok(policy.distance < 1000 * 0.31, `distance ${policy.distance} should stay under 310`);
    });

    it('caps the linear distance at 30% of the longest axis', () => {
      // For an "okay" feature size that solves to a huge distance, the
      // cap keeps us inside a usable slice of the alignment.
      const policy = pickFitPolicy(
        bounds(0, 0, 0, 10_000, 100, 100),
        { fovY: FOV_45 },
      );
      assert.strictEqual(policy.kind, 'linear');
      assert.ok(policy.distance <= 10_000 * 0.3, `distance ${policy.distance} should be capped at 3000`);
    });
  });

  it('honours an override threshold (so tests can pin the boundary)', () => {
    // Aspect 5:1 — normally compact. Force linear by lowering threshold.
    const b = bounds(0, 0, 0, 100, 20, 20);
    assert.strictEqual(pickFitPolicy(b, { fovY: FOV_45 }).kind, 'compact');
    assert.strictEqual(
      pickFitPolicy(b, { fovY: FOV_45, linearAspectThreshold: 4 }).kind,
      'linear',
    );
  });
});
