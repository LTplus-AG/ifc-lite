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
} from './contribution-cull.js';

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

  // `pixelRadius <= 0` means DISABLED, and disabled must win over any motion
  // boost: a viewer that opted out of contribution culling must not start
  // dropping sub-pixel geometry the moment the user grabs the orbit control.
  // Guards the `> 0` in the disable check (a `>= 0` there lets the motion
  // branch resurrect culling from a pixelRadius of exactly 0).
  it('stays disabled while interacting when pixelRadius is 0, even with a motion boost', () => {
    assert.strictEqual(
      resolveContributionThresholdPx({ pixelRadius: 0, interactingPixelRadius: 8 }, true),
      0,
    );
    assert.strictEqual(
      resolveContributionThresholdPx({ pixelRadius: -1, interactingPixelRadius: 8 }, true),
      0,
    );
    // Both directions: the smallest positive radius is NOT disabled, and the
    // motion boost applies to it normally.
    assert.strictEqual(
      resolveContributionThresholdPx(
        { pixelRadius: Number.MIN_VALUE, interactingPixelRadius: 8 },
        true,
      ),
      8,
    );
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

  // The tangency boundary itself: depth EXACTLY equal to the bounding-sphere
  // radius means the sphere touches the camera plane, which the contract
  // treats as "never cull". Pinned in both directions — one epsilon further
  // out must produce a finite (cullable) projection, or the guard would be
  // swallowing everything near the camera.
  it('fails open at exactly depth === radius, and projects finitely just beyond it', () => {
    // Box [-1,-1,-2]..[1,1,0] → half-diagonal radius = sqrt(4+4+4)/2 = sqrt(3).
    const radius = Math.sqrt(3);
    const cam = perspectiveCam();
    // Centre at z = -radius → view depth (down -Z) is exactly `radius`.
    const centreZ = -radius;
    const atBoundary = projectedAabbRadiusPx(
      [-1, -1, centreZ - 1],
      [1, 1, centreZ + 1],
      cam,
    );
    assert.strictEqual(atBoundary, Infinity, 'depth === radius must fail open');

    // Push the same box far enough out that depth > radius: now cullable.
    const farZ = -radius * 100;
    const beyond = projectedAabbRadiusPx([-1, -1, farZ - 1], [1, 1, farZ + 1], cam);
    assert.ok(Number.isFinite(beyond), `depth > radius must project finitely, got ${beyond}`);
    assert.ok(beyond > 0, `expected a positive pixel radius, got ${beyond}`);
  });
});

describe('projectedAabbRadiusPx (orthographic)', () => {
  const orthoCam = (orthoHalfHeight: number): CullCameraState => ({
    eye: { x: 0, y: 0, z: 0 },
    viewDir: { x: 0, y: 0, z: -1 }, // unused in ortho, required by the interface
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

  // The test above only ever exercises the Z axis: with an axis-aligned
  // viewDir the X and Y corner picks are multiplied by a zero direction
  // component and cannot affect the result. A real orbit camera looks
  // obliquely, so all three axes must be pinned independently — picking the
  // FAR corner on any axis over-estimates the depth, under-estimates the
  // projected size, and silently culls instanced templates (repeated bolts,
  // windows, furniture) that are actually large on screen.
  it('picks the nearest corner on EVERY axis under an oblique view direction', () => {
    const inv = 1 / Math.sqrt(3);
    const min: [number, number, number] = [100, 200, 300];
    const max: [number, number, number] = [140, 260, 380];
    const centre: [number, number, number] = [
      (min[0] + max[0]) / 2,
      (min[1] + max[1]) / 2,
      (min[2] + max[2]) / 2,
    ];
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        for (const sz of [1, -1]) {
          const viewDir = { x: sx * inv, y: sy * inv, z: sz * inv };
          // Orbit the eye 500 units BACK along its own view direction from the
          // box centre, so the box is genuinely in front of the camera in all
          // eight octants. With the eye pinned at the origin, five of the eight
          // sign combinations put the box BEHIND the camera, where the nearest
          // and the far corner both yield a non-positive depth and the function
          // returns Infinity either way — those iterations assert nothing. A
          // z-axis corner regression (`nz = unionMin[2]`, ignoring the sign)
          // survives the origin-eye fixture untouched.
          const cam = perspectiveCam({
            viewDir,
            eye: {
              x: centre[0] - 500 * viewDir.x,
              y: centre[1] - 500 * viewDir.y,
              z: centre[2] - 500 * viewDir.z,
            },
          });
          const px = projectedInstancedRadiusPx(min, max, 2, cam);

          // Independent oracle: brute-force the minimum view depth over all
          // eight corners of the union box, which is what the per-axis sign
          // trick is a shortcut for.
          let minDepth = Infinity;
          for (const x of [min[0], max[0]]) {
            for (const y of [min[1], max[1]]) {
              for (const z of [min[2], max[2]]) {
                const d =
                  (x - cam.eye.x) * cam.viewDir.x +
                  (y - cam.eye.y) * cam.viewDir.y +
                  (z - cam.eye.z) * cam.viewDir.z;
                if (d < minDepth) minDepth = d;
              }
            }
          }
          // Guard the fixture itself: every octant must stay in front of the
          // camera, or the assertion below degenerates into Infinity ===
          // Infinity and stops discriminating.
          assert.ok(
            minDepth > 2,
            `sx=${sx} sy=${sy} sz=${sz}: fixture must sit in front of the camera (minDepth ${minDepth})`,
          );
          const expected = (2 / minDepth) * 500;
          assert.ok(
            Math.abs(px - expected) < 1e-9,
            `sx=${sx} sy=${sy} sz=${sz}: got ${px}, expected ${expected}`,
          );
        }
      }
    }
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

  // The perspective case above is masked: `!(minDepth > Infinity)` and
  // `!(minDepth > NaN)` both already return Infinity, so the non-finite
  // guard is invisible there. The ORTHOGRAPHIC branch has no such downstream
  // check — without the guard, a NaN radius divides straight through and the
  // function returns NaN, which every `radius < threshold` comparison reads
  // as false. That happens to avoid culling, but it leaks NaN into the
  // renderer's cull bookkeeping instead of the documented Infinity.
  it('orthographic: fails open with Infinity (not NaN) on poisoned/NaN maxOccRadius', () => {
    const orthoCam: CullCameraState = {
      eye: { x: 0, y: 0, z: 0 },
      viewDir: { x: 0, y: 0, z: -1 },
      mode: 'orthographic',
      fovYRadians: 0,
      orthoHalfHeight: 100,
      viewportHeightPx: 1000,
    };
    assert.strictEqual(
      projectedInstancedRadiusPx([-1, -1, -101], [1, 1, -99], Infinity, orthoCam),
      Infinity,
    );
    assert.strictEqual(
      projectedInstancedRadiusPx([-1, -1, -101], [1, 1, -99], NaN, orthoCam),
      Infinity,
    );
    // Opposite direction: a finite radius still projects finitely in ortho.
    assert.ok(
      Number.isFinite(projectedInstancedRadiusPx([-1, -1, -101], [1, 1, -99], 0.5, orthoCam)),
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
      viewDir: { x: 0, y: 0, z: -1 }, // unused in ortho, required by the interface
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
