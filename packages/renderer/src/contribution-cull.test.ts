/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  projectedAabbRadiusPx,
  resolveContributionThresholdPx,
  type CullCameraState,
} from './contribution-cull.ts';

const perspectiveCam = (overrides: Partial<CullCameraState> = {}): CullCameraState => ({
  eye: { x: 0, y: 0, z: 0 },
  viewDir: { x: 0, y: 0, z: -1 }, // looking down -Z
  mode: 'perspective',
  fovYRadians: Math.PI / 2, // tan(fov/2) = 1 → pixels = radius / depth * halfViewport
  orthoHalfHeight: 0,
  viewportHeightPx: 1000,
  ...overrides,
});

describe('resolveContributionThresholdPx', () => {
  it('returns 0 (disabled) without options or with non-positive radius', () => {
    assert.strictEqual(resolveContributionThresholdPx(undefined, false), 0);
    assert.strictEqual(resolveContributionThresholdPx({ pixelRadius: 0 }, false), 0);
    assert.strictEqual(resolveContributionThresholdPx({ pixelRadius: -1 }, true), 0);
    assert.strictEqual(resolveContributionThresholdPx({ pixelRadius: NaN }, true), 0);
  });

  it('uses pixelRadius at rest and interactingPixelRadius while moving', () => {
    const opts = { pixelRadius: 0.5, interactingPixelRadius: 2 };
    assert.strictEqual(resolveContributionThresholdPx(opts, false), 0.5);
    assert.strictEqual(resolveContributionThresholdPx(opts, true), 2);
  });

  it('falls back to pixelRadius while moving when no interacting radius is set', () => {
    assert.strictEqual(resolveContributionThresholdPx({ pixelRadius: 0.5 }, true), 0.5);
  });

  it('never culls LESS during motion: interacting radius is clamped up to pixelRadius', () => {
    const opts = { pixelRadius: 2, interactingPixelRadius: 0.5 };
    assert.strictEqual(resolveContributionThresholdPx(opts, true), 2);
  });
});

describe('projectedAabbRadiusPx (perspective)', () => {
  it('projects a unit-diagonal box at known distance to the expected pixel radius', () => {
    // Box centred at z=-100, half-diagonal = sqrt(3*4)/2 = sqrt(12)/2 ≈ 1.732.
    // With tan(fov/2)=1 and halfViewport=500: px = r / dist * 500.
    const px = projectedAabbRadiusPx([-1, -1, -101], [1, 1, -99], perspectiveCam());
    const r = Math.sqrt(12) / 2;
    assert.ok(Math.abs(px - (r / 100) * 500) < 1e-9, `got ${px}`);
  });

  it('shrinks with distance (monotonic falloff)', () => {
    const near = projectedAabbRadiusPx([-1, -1, -11], [1, 1, -9], perspectiveCam());
    const far = projectedAabbRadiusPx([-1, -1, -1001], [1, 1, -999], perspectiveCam());
    assert.ok(near > far);
  });

  it('returns Infinity when the camera is inside the bounding sphere (never cull)', () => {
    const px = projectedAabbRadiusPx([-10, -10, -10], [10, 10, 10], perspectiveCam());
    assert.strictEqual(px, Infinity);
  });

  it('projects a degenerate (point) AABB to 0 px', () => {
    const px = projectedAabbRadiusPx([5, 5, -50], [5, 5, -50], perspectiveCam());
    assert.strictEqual(px, 0);
  });

  it('uses view DEPTH, not Euclidean distance: off-axis boxes never read smaller than on-axis', () => {
    // Same depth (100), one on-axis, one far off-axis (Euclidean distance 100*sqrt(2)).
    const onAxis = projectedAabbRadiusPx([-1, -1, -101], [1, 1, -99], perspectiveCam());
    const offAxis = projectedAabbRadiusPx([99, -1, -101], [101, 1, -99], perspectiveCam());
    assert.ok(Math.abs(onAxis - offAxis) < 1e-9, `on=${onAxis} off=${offAxis}`);
  });

  it('never culls a near-camera box even when its centre is beside the eye (depth <= radius)', () => {
    // Centre at depth 0.5, sphere radius ~1.7: overlaps the camera plane.
    const px = projectedAabbRadiusPx([9, -1, -1.5], [11, 1, 0.5], perspectiveCam());
    assert.strictEqual(px, Infinity);
  });

  it('never culls behind-camera boxes (frustum test owns that rejection)', () => {
    const px = projectedAabbRadiusPx([-1, -1, 99], [1, 1, 101], perspectiveCam());
    assert.strictEqual(px, Infinity);
  });

  it('fails open on a zero/negative viewport height (mid-resize race)', () => {
    for (const viewportHeightPx of [0, -100]) {
      const px = projectedAabbRadiusPx(
        [-1, -1, -101],
        [1, 1, -99],
        perspectiveCam({ viewportHeightPx }),
      );
      assert.strictEqual(px, Infinity);
    }
  });

  it('fails open on a degenerate/zero view direction', () => {
    const px = projectedAabbRadiusPx(
      [-1, -1, -101],
      [1, 1, -99],
      perspectiveCam({ viewDir: { x: 0, y: 0, z: 0 } }),
    );
    assert.strictEqual(px, Infinity);
  });
});

describe('projectedAabbRadiusPx (orthographic)', () => {
  const orthoCam = (orthoHalfHeight: number): CullCameraState => ({
    eye: { x: 0, y: 0, z: 0 },
    mode: 'orthographic',
    fovYRadians: 0,
    orthoHalfHeight,
    viewportHeightPx: 1000,
  });

  it('is distance-independent and scales with ortho zoom', () => {
    const a = projectedAabbRadiusPx([-1, -1, -11], [1, 1, -9], orthoCam(100));
    const b = projectedAabbRadiusPx([-1, -1, -100001], [1, 1, -99999], orthoCam(100));
    assert.strictEqual(a, b);
    // halfViewport=500, r=sqrt(12)/2, halfHeight=100 → px = r/100*500
    assert.ok(Math.abs(a - (Math.sqrt(12) / 2 / 100) * 500) < 1e-9);
    // Zooming in (smaller half-height) makes everything bigger on screen.
    assert.ok(projectedAabbRadiusPx([-1, -1, -11], [1, 1, -9], orthoCam(10)) > a);
  });

  it('never culls on a degenerate ortho volume', () => {
    assert.strictEqual(projectedAabbRadiusPx([-1, -1, -11], [1, 1, -9], orthoCam(0)), Infinity);
  });
});
