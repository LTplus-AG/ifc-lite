/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  projectedAabbRadiusPx,
  projectedInstancedRadiusPx,
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

describe('projectedInstancedRadiusPx (instanced templates)', () => {
  // tan(fov/2)=1, halfViewport=500 → px = r / minDepth * 500.
  it('projects the max occurrence radius at the union box NEAREST view depth', () => {
    // Union box z ∈ [-200, -100] looking down -Z: nearest depth = 100.
    const px = projectedInstancedRadiusPx([-50, -50, -200], [50, 50, -100], 1, perspectiveCam());
    assert.ok(Math.abs(px - (1 / 100) * 500) < 1e-9, `got ${px}`);
  });

  it('is an upper bound for every real occurrence in the box', () => {
    const cam = perspectiveCam();
    const unionMin: [number, number, number] = [-40, -40, -300];
    const unionMax: [number, number, number] = [40, 40, -100];
    const maxOccRadius = 0.5;
    const bound = projectedInstancedRadiusPx(unionMin, unionMax, maxOccRadius, cam);
    // Sample occurrence spheres of radius <= maxOccRadius centred inside the box.
    for (const [x, y, z, r] of [
      [0, 0, -100.5, 0.5], // nearest face, max radius — the worst case
      [39, -39, -150, 0.4],
      [0, 40, -299, 0.1],
    ] as const) {
      const occ = projectedAabbRadiusPx(
        [x - r, y - r, z - r],
        [x + r, y + r, z + r],
        cam,
      );
      // The occurrence's own AABB half-diagonal is sqrt(3)*r (> r), so compare
      // against the sphere projection directly: r / depth * 500.
      const sphere = (r / -z) * 500;
      assert.ok(sphere <= bound + 1e-9, `occ at z=${z} r=${r}: sphere ${sphere} > bound ${bound}`);
      assert.ok(occ >= sphere, 'sanity: AABB projection over-estimates the sphere');
    }
  });

  it('picks the nearest corner per viewDir sign (not a fixed corner)', () => {
    // Looking down +Z from z=0: nearest depth of box z ∈ [100, 200] is 100.
    const cam = perspectiveCam({ viewDir: { x: 0, y: 0, z: 1 } });
    const px = projectedInstancedRadiusPx([-10, -10, 100], [10, 10, 200], 2, cam);
    assert.ok(Math.abs(px - (2 / 100) * 500) < 1e-9, `got ${px}`);
  });

  it('fails open when an occurrence could reach the camera plane (minDepth <= radius)', () => {
    const px = projectedInstancedRadiusPx([-10, -10, -10], [10, 10, -1], 5, perspectiveCam());
    assert.strictEqual(px, Infinity);
  });

  it('fails open when the union box is behind the camera', () => {
    const px = projectedInstancedRadiusPx([-1, -1, 50], [1, 1, 100], 0.5, perspectiveCam());
    assert.strictEqual(px, Infinity);
  });

  it('fails open on poisoned metadata (maxOccRadius = Infinity) and NaN radius', () => {
    assert.strictEqual(
      projectedInstancedRadiusPx([-1, -1, -101], [1, 1, -99], Infinity, perspectiveCam()),
      Infinity,
    );
    assert.strictEqual(
      projectedInstancedRadiusPx([-1, -1, -101], [1, 1, -99], NaN, perspectiveCam()),
      Infinity,
    );
  });

  it('fails open on degenerate camera (viewport, viewDir, fov)', () => {
    const args: [readonly [number, number, number], readonly [number, number, number], number] =
      [[-1, -1, -101], [1, 1, -99], 0.5];
    assert.strictEqual(
      projectedInstancedRadiusPx(...args, perspectiveCam({ viewportHeightPx: 0 })),
      Infinity,
    );
    assert.strictEqual(
      projectedInstancedRadiusPx(...args, perspectiveCam({ viewDir: { x: 0, y: 0, z: 0 } })),
      Infinity,
    );
    assert.strictEqual(
      projectedInstancedRadiusPx(...args, perspectiveCam({ fovYRadians: 0 })),
      Infinity,
    );
  });

  it('orthographic: depth-independent, scales with zoom', () => {
    const cam: CullCameraState = {
      eye: { x: 0, y: 0, z: 0 },
      mode: 'orthographic',
      fovYRadians: 0,
      orthoHalfHeight: 100,
      viewportHeightPx: 1000,
    };
    const px = projectedInstancedRadiusPx([-1, -1, -1e6], [1, 1, -1e6 + 2], 0.5, cam);
    assert.ok(Math.abs(px - (0.5 / 100) * 500) < 1e-9, `got ${px}`);
    assert.strictEqual(
      projectedInstancedRadiusPx([-1, -1, -10], [1, 1, -8], 0.5, { ...cam, orthoHalfHeight: 0 }),
      Infinity,
    );
  });

  it('a bolts-everywhere template culls at threshold even though its union box is model-sized', () => {
    // 200m union box starting 20m from the camera; each bolt <= 5mm radius.
    // Upper bound: 0.005 / 20 * 500 = 0.125 px — below any practical threshold,
    // while the union box itself would project as Infinity (camera inside).
    const cam = perspectiveCam();
    const px = projectedInstancedRadiusPx([-100, -100, -220], [100, 100, -20], 0.005, cam);
    assert.ok(px < 0.2, `got ${px}`);
    assert.strictEqual(
      projectedAabbRadiusPx([-100, -100, -220], [100, 100, -20], cam),
      Infinity,
      'sanity: the union box itself is useless for culling',
    );
  });
});
