/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Every "put the camera on this box" entry point — `frameBounds`,
 * `zoomExtent`, `fitToBounds`, `setPresetView`, `fitBoundsAdaptive` — computes
 * `center = (min + max) / 2` and `size = max - min` and writes both straight
 * into the pose. `Math.max` picking the largest extent is NaN-transparent, so
 * one bad coordinate reaches `position`, `target` and, in orthographic mode,
 * `orthoSize`. #2450 backstopped the projection *matrix* at its read site;
 * `getOrthoSize()` reads the *state*, and that is what a saved viewpoint
 * persists — so a bad fit outlives the session (#2461).
 *
 * Reachability, traced rather than assumed. Every AABB accumulator in this
 * package seeds `min = +Infinity, max = -Infinity` and narrows on a bare
 * comparison, which is false for a non-finite vertex. `Scene.getEntityBoundingBox`
 * has no finiteness filter and CACHES its result, and `Scene.addMeshData`
 * validates nothing — so a mesh piece with zero-length or all-non-finite
 * positions makes it return, and keep returning, that inverted sentinel as if
 * it were a real box. `model-bounds-tracker.test.ts` already pins exactly that
 * value as the tracker's output for "a mesh with no finite vertex". Four call
 * sites hand such a box straight to the camera with only a null check between:
 * BCF zoom-to-topic, instanced frame-selection, clash framing and the
 * point-cloud fit. Upstream of all of it, `#1645` fixed a class of malformed
 * `IfcDirection((0,0,0))` producing a NaN placement matrix — and one caller
 * (`profile_extractor.rs`'s bare `normalize()`) still routes around that fix.
 *
 * Scope: the camera's decision about what an unusable box means. The Scene-side
 * cache that produces one is a separate blast radius (it feeds raycasting,
 * section ranges and clash) and is deliberately not touched here.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.js';
import type { Vec3 } from './types.js';

function healthyCamera(mode: 'perspective' | 'orthographic' = 'perspective'): Camera {
  const camera = new Camera();
  camera.setAspect(16 / 9);
  camera.setPosition(50, 50, 100);
  camera.setTarget(0, 0, 0);
  if (mode === 'orthographic') camera.setProjectionMode(mode);
  return camera;
}

function poseOf(camera: Camera): { position: Vec3; target: Vec3; orthoSize: number } {
  return { position: camera.getPosition(), target: camera.getTarget(), orthoSize: camera.getOrthoSize() };
}

function assertStateFinite(camera: Camera, label: string): void {
  for (const [name, v] of [['position', camera.getPosition()], ['target', camera.getTarget()]] as const) {
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(Number.isFinite(v[axis]), `${label}: ${name}.${axis} is ${v[axis]}`);
    }
  }
  assert.ok(Number.isFinite(camera.getOrthoSize()), `${label}: orthoSize is ${camera.getOrthoSize()}`);
}

/**
 * The unusable boxes, and why each one is in the list.
 *
 * `inverted-empty` is the cheapest reproducer of all and needs no NaN
 * anywhere: it is the empty-AABB sentinel every accumulator here starts from,
 * returned verbatim when nothing narrowed it. `Infinity` is kept separate from
 * `NaN` throughout because the two do not behave alike — `maxSize` for the
 * inverted-empty box is `-Infinity`, which *passes* the `< 1e-6` small-box
 * test and routes into `framePoint` with a NaN centre, while a NaN `maxSize`
 * fails it and proceeds into the full distance math. Different code paths,
 * same destroyed pose.
 */
const UNUSABLE_BOUNDS: Array<[string, Vec3, Vec3]> = [
  ['NaN min.x', { x: Number.NaN, y: 0, z: 0 }, { x: 10, y: 10, z: 10 }],
  ['NaN max.y', { x: 0, y: 0, z: 0 }, { x: 10, y: Number.NaN, z: 10 }],
  ['infinite span', { x: -Infinity, y: 0, z: 0 }, { x: Infinity, y: 10, z: 10 }],
  ['inverted-empty sentinel',
    { x: Infinity, y: Infinity, z: Infinity },
    { x: -Infinity, y: -Infinity, z: -Infinity }],
  ['finite but inverted', { x: 10, y: 10, z: 10 }, { x: 0, y: 0, z: 0 }],
];

/**
 * Drive a camera animation on a fake clock. Same shape as the helpers in
 * `camera-degenerate-pose-matrix.test.ts` and `camera-preset-orbit.test.ts`:
 * the animator's completion promise is chained off `requestAnimationFrame`,
 * which does not exist under `node:test`, so the animation is stepped by hand
 * and the promise is never awaited.
 */
function withStubbedFrameClock(run: (advance: (ms: number) => void) => void): void {
  const originalNow = Date.now;
  const hadRaf = Object.prototype.hasOwnProperty.call(globalThis, 'requestAnimationFrame');
  const originalRaf = Reflect.get(globalThis, 'requestAnimationFrame');
  let now = 1_000;

  Date.now = () => now;
  Reflect.set(globalThis, 'requestAnimationFrame', () => 0);

  try {
    run((ms) => { now += ms; });
  } finally {
    Date.now = originalNow;
    if (hadRaf) {
      Reflect.set(globalThis, 'requestAnimationFrame', originalRaf);
    } else {
      Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
    }
  }
}

/** Run the tween to completion: past the duration, then one final update. */
function settle(camera: Camera, advance: (ms: number) => void, duration = 20): void {
  advance(duration + 1);
  camera.update(16);
}

describe('camera fit rejects an unusable AABB (#2461)', () => {
  it('frameBounds and zoomExtent leave the pose and orthoSize untouched', () => {
    withStubbedFrameClock((advance) => {
      for (const [label, min, max] of UNUSABLE_BOUNDS) {
        for (const mode of ['perspective', 'orthographic'] as const) {
          for (const [name, fit] of [
            ['frameBounds', (c: Camera) => { void c.frameBounds(min, max, 20); }],
            ['zoomExtent', (c: Camera) => { void c.zoomExtent(min, max, 20); }],
          ] as const) {
            const camera = healthyCamera(mode);
            const before = poseOf(camera);
            fit(camera);
            settle(camera, advance);
            const tag = `${name} ${mode} ${label}`;
            assertStateFinite(camera, tag);
            assert.deepStrictEqual(poseOf(camera), before, `${tag}: the fit must not be applied`);
          }
        }
      }
    });
  });

  it('fitToBounds, setPresetView and fitBoundsAdaptive do the same', () => {
    withStubbedFrameClock((advance) => {
      for (const [label, min, max] of UNUSABLE_BOUNDS) {
        {
          const camera = healthyCamera('orthographic');
          const before = poseOf(camera);
          camera.fitToBounds(min, max);
          assertStateFinite(camera, `fitToBounds ${label}`);
          assert.deepStrictEqual(poseOf(camera), before, `fitToBounds ${label}: must not be applied`);
        }
        {
          const camera = healthyCamera('orthographic');
          const before = poseOf(camera);
          camera.setPresetView('top', { min, max });
          settle(camera, advance, 300);
          assertStateFinite(camera, `setPresetView ${label}`);
          assert.deepStrictEqual(poseOf(camera), before, `setPresetView ${label}: must not be applied`);
        }
        {
          const camera = healthyCamera('orthographic');
          const before = poseOf(camera);
          const policy = camera.fitBoundsAdaptive({ min, max });
          assertStateFinite(camera, `fitBoundsAdaptive ${label}`);
          assert.deepStrictEqual(poseOf(camera), before, `fitBoundsAdaptive ${label}: must not be applied`);
          // The returned policy is applied by some callers and read for its
          // `kind` by others; either way it must not carry the damage back out.
          for (const axis of ['x', 'y', 'z'] as const) {
            assert.ok(
              Number.isFinite(policy.position[axis]) && Number.isFinite(policy.target[axis]),
              `fitBoundsAdaptive ${label}: policy.${axis} is non-finite`,
            );
          }
        }
      }
    });
  });

  it('the projection matrix stays finite through all of it', () => {
    withStubbedFrameClock((advance) => {
      for (const [label, min, max] of UNUSABLE_BOUNDS) {
        const camera = healthyCamera('orthographic');
        void camera.frameBounds(min, max, 20);
        settle(camera, advance);
        const m = Array.from(camera.getViewProjMatrix().m);
        const bad = m.findIndex((v) => !Number.isFinite(v));
        assert.strictEqual(bad, -1, `${label}: matrix component ${bad} is ${m[bad]}`);
      }
    });
  });

  it('anti-mutation: a degenerate but valid box is still framed', () => {
    // `max === min` is a flat wall, a single point, a plan-only model — all
    // legitimate, all things `frameBounds` already centres on. A guard written
    // `max > min` instead of `max >= min` would reject them, and every
    // assertion above would still pass while frame-selection was dead for
    // anything planar.
    const degenerate: Array<[string, Vec3, Vec3]> = [
      ['single point', { x: 5, y: 5, z: 5 }, { x: 5, y: 5, z: 5 }],
      ['flat in Y', { x: 0, y: 3, z: 0 }, { x: 10, y: 3, z: 10 }],
      ['flat in X and Z', { x: 2, y: 0, z: 2 }, { x: 2, y: 10, z: 2 }],
    ];
    withStubbedFrameClock((advance) => {
      for (const [label, min, max] of degenerate) {
        const camera = healthyCamera('orthographic');
        const before = poseOf(camera);
        void camera.frameBounds(min, max, 20);
        settle(camera, advance);
        assertStateFinite(camera, `degenerate ${label}`);
        assert.notDeepStrictEqual(poseOf(camera), before, `degenerate ${label}: the fit must still apply`);
      }
    });
  });

  it('anti-mutation: an ordinary box still fits, in both modes', () => {
    const min = { x: 0, y: 0, z: 0 };
    const max = { x: 20, y: 10, z: 15 };
    withStubbedFrameClock((advance) => {
      for (const mode of ['perspective', 'orthographic'] as const) {
        for (const [name, fit] of [
          ['frameBounds', (c: Camera) => { void c.frameBounds(min, max, 20); }],
          ['zoomExtent', (c: Camera) => { void c.zoomExtent(min, max, 20); }],
        ] as const) {
          const camera = healthyCamera(mode);
          const before = poseOf(camera);
          fit(camera);
          settle(camera, advance);
          assertStateFinite(camera, `control ${name} ${mode}`);
          assert.notDeepStrictEqual(poseOf(camera), before, `control ${name} ${mode}: must move the camera`);
        }

        const preset = healthyCamera(mode);
        const beforePreset = poseOf(preset);
        preset.setPresetView('top', { min, max });
        settle(preset, advance, 300);
        assert.notDeepStrictEqual(poseOf(preset), beforePreset, `control setPresetView ${mode}: must move the camera`);

        const snap = healthyCamera(mode);
        const beforeSnap = poseOf(snap);
        snap.fitToBounds(min, max);
        assert.notDeepStrictEqual(poseOf(snap), beforeSnap, `control fitToBounds ${mode}: must move the camera`);

        const adaptive = healthyCamera(mode);
        const beforeAdaptive = poseOf(adaptive);
        adaptive.fitBoundsAdaptive({ min, max });
        assert.notDeepStrictEqual(poseOf(adaptive), beforeAdaptive, `control fitBoundsAdaptive ${mode}: must move the camera`);
      }
    });
  });
});

describe('orthoSize state cannot go non-finite through its direct writers (#2461)', () => {
  it('the orthographic zoom keeps getOrthoSize() finite for a malformed delta', () => {
    // `zoomOrthographic` writes `state.orthoSize` without going near
    // `setOrthoSize`, and `Math.max(0.01, NaN)` is NaN, not the floor. The
    // matrix was backstopped; `getOrthoSize()` was not, and that is the value
    // a saved viewpoint carries.
    for (const delta of [Number.NaN, Infinity, -Infinity]) {
      const camera = healthyCamera('orthographic');
      const before = camera.getOrthoSize();
      assert.ok(before > 0, 'precondition: the camera started with a usable half-height');
      camera.zoom(delta, false, 700, 100, 800, 600);
      assert.ok(
        Number.isFinite(camera.getOrthoSize()),
        `zoom(${delta}): orthoSize is ${camera.getOrthoSize()}`,
      );
    }
  });

  it('an orthoSize large enough to overflow is not written', () => {
    // The reachable Infinity: a legitimately huge but finite half-height
    // multiplied by a zoom-out factor overflows, and `Math.max` forwards it.
    const camera = healthyCamera('orthographic');
    camera.setOrthoSize(Number.MAX_VALUE);
    camera.zoom(1000);
    assert.ok(
      Number.isFinite(camera.getOrthoSize()),
      `orthoSize is ${camera.getOrthoSize()} after zooming out from MAX_VALUE`,
    );
  });

  it('the animator cannot interpolate a non-finite half-height into state', () => {
    // The second direct writer. `frameBounds` is guarded now, so drive the
    // animator through `animateTo`'s end-size path with a hand-poked start.
    withStubbedFrameClock((advance) => {
      const camera = healthyCamera('orthographic');
      camera.setOrthoSize(Number.MAX_VALUE);
      void camera.frameBounds({ x: 0, y: 0, z: 0 }, { x: 1e308, y: 1e308, z: 1e308 }, 20);
      for (let i = 0; i < 4; i++) { advance(6); camera.update(16); }
      assert.ok(
        Number.isFinite(camera.getOrthoSize()),
        `orthoSize is ${camera.getOrthoSize()} mid-animation`,
      );
      settle(camera, advance);
      assert.ok(
        Number.isFinite(camera.getOrthoSize()),
        `orthoSize is ${camera.getOrthoSize()} at animation end`,
      );
    });
  });

  it('anti-mutation: an ordinary orthographic zoom still changes the half-height', () => {
    const camera = healthyCamera('orthographic');
    const before = camera.getOrthoSize();
    camera.zoom(120, false, 700, 100, 800, 600);
    assert.notStrictEqual(camera.getOrthoSize(), before, 'a valid zoom must change orthoSize');
    assert.ok(Number.isFinite(camera.getOrthoSize()));
  });
});
