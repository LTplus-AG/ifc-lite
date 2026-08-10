/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The fit pickers have to produce a pose that actually *shows* the box they
 * were handed, on the viewport shape they were handed. Three ways they did
 * not, all of them pre-existing on `origin/main` and all of them surfaced by
 * the camera module split (PR #2500):
 *
 *  1. **Portrait viewports.** Every fit distance in this package was derived
 *     from the vertical field of view alone. The horizontal half-angle is
 *     `atan(tan(fov / 2) * aspect)`, so for `aspect < 1` the horizontal field
 *     is the *narrower* of the two and the box overflows left and right — the
 *     fit clips the very thing it was asked to frame. (`orthoSizeFor` had
 *     divided by `aspect` since it was written; the perspective half of the
 *     same rule was missing.)
 *  2. **`zoomExtent` on a degenerate box.** `isUsableBounds` deliberately
 *     admits `max === min`, and for such a box the fit distance is zero, so
 *     `position` was written equal to `target` — a pose with no view direction
 *     at all. `frameBounds` has always special-cased this; `zoomExtent` did not.
 *  3. **A non-finite `buildingRotation`.** The IfcSite placement angle reaches
 *     `Camera.setPresetView` — a published entry point — without ever meeting
 *     a guard, and `Math.cos(NaN)` is NaN.
 *
 * Written against the pure pickers rather than the animated facades: these are
 * assertions about the pose that was *chosen*, and routing them through a tween
 * would only add a frame clock between the assertion and the thing it is about.
 * The facades' own null-check contract is covered in
 * `camera-malformed-bounds-fit.test.ts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { Vec3, Camera as CameraType, Mat4 } from './types.js';
import type { CameraInternalState } from './camera-state.js';
import { frameBoundsTarget, zoomExtentTarget } from './camera-framing.js';
import { presetViewTarget } from './camera-preset-view.js';
import { Camera } from './camera.js';

const FOV = Math.PI / 4;

function makeMat4(): Mat4 {
  return { m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
}

/**
 * A state whose view matrix is the identity, which makes
 * `frameBoundsTarget`'s "forward is the negative Z column" read out as
 * `(0, 0, -1)` — a well-defined direction, so the fit takes its primary path
 * rather than either fallback.
 */
function makeState(aspect: number, mode: 'perspective' | 'orthographic' = 'perspective'): CameraInternalState {
  const camera: CameraType = {
    position: { x: 0, y: 0, z: 100 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    fov: FOV,
    aspect,
    near: 0.1,
    far: 10000,
  };
  return {
    camera,
    viewMatrix: makeMat4(),
    projMatrix: makeMat4(),
    viewProjMatrix: makeMat4(),
    projectionMode: mode,
    orthoSize: 50,
    sceneBounds: null,
    orbitAnchorBounds: null,
  };
}

function distanceBetween(a: Vec3, b: Vec3): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

/**
 * Drive the tween off a stubbed clock. Same helper as
 * `camera-malformed-bounds-fit.test.ts`; the animator reads `Date.now` and
 * schedules through `requestAnimationFrame`, neither of which exists usefully
 * under `node:test`.
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

/** A 20-unit cube centred on the origin. `maxExtentOf` is 20. */
const CUBE_MIN: Vec3 = { x: -10, y: -10, z: -10 };
const CUBE_MAX: Vec3 = { x: 10, y: 10, z: 10 };
const CUBE_SIZE = 20;

/**
 * Half-extent of the box at `distance`, measured against the *horizontal*
 * field of view. `< 1` means it fits; `> 1` means it is cut off at the left
 * and right edges of a portrait window.
 */
function horizontalFill(distance: number, size: number, aspect: number): number {
  const halfWidthAtDistance = distance * Math.tan(FOV / 2) * aspect;
  return (size / 2) / halfWidthAtDistance;
}

describe('fit distance honours the horizontal field of view (#2500)', () => {
  it('pulls back far enough for a portrait viewport', () => {
    // 9:16 phone/tablet portrait. Against the vertical field alone the cube
    // fitted at `10 / tan(fov/2) * padding`; the horizontal field is 0.5625x
    // as wide, so the same distance left the cube 1.7x too wide for the
    // window and frame-selection cut its sides off.
    const aspect = 9 / 16;
    for (const [label, pick, padding] of [
      ['frameBounds', frameBoundsTarget, 1.2],
      ['zoomExtent', zoomExtentTarget, 1.5],
    ] as const) {
      const state = makeState(aspect);
      const fit = pick(state, CUBE_MIN, CUBE_MAX);
      assert.ok(fit, `${label}: the box is usable and must produce a fit`);
      const distance = distanceBetween(fit.position, fit.target);
      const fill = horizontalFill(distance, CUBE_SIZE, aspect);
      assert.ok(
        fill <= 1 / padding + 1e-9,
        `${label}: the cube fills ${fill.toFixed(3)} of the horizontal field at distance ${distance.toFixed(3)}; ` +
        `with ${padding}x padding it must fill at most ${(1 / padding).toFixed(3)}`,
      );
    }
  });

  it('pulls back far enough for a portrait viewport in a preset view', () => {
    const aspect = 9 / 16;
    const state = makeState(aspect);
    const fit = presetViewTarget(state, 'front', { min: CUBE_MIN, max: CUBE_MAX }, 0);
    const distance = distanceBetween(fit.position, fit.target);
    const fill = horizontalFill(distance, CUBE_SIZE, aspect);
    assert.ok(
      fill <= 1 / 1.5 + 1e-9,
      `preset front: the cube fills ${fill.toFixed(3)} of the horizontal field at distance ${distance.toFixed(3)}`,
    );
  });

  it('anti-mutation: a landscape viewport is bit-for-bit unchanged', () => {
    // The vertical field is the binding one for every `aspect >= 1`, so the
    // aspect term must contribute exactly nothing there. If this drifts, the
    // fix has changed the framing of every desktop viewport rather than only
    // the portrait one it was for.
    for (const aspect of [1, 4 / 3, 16 / 9, 21 / 9]) {
      const vertical = (CUBE_SIZE / 2) / Math.tan(FOV / 2);
      for (const [label, pick, padding] of [
        ['frameBounds', frameBoundsTarget, 1.2],
        ['zoomExtent', zoomExtentTarget, 1.5],
      ] as const) {
        const fit = pick(makeState(aspect), CUBE_MIN, CUBE_MAX);
        assert.ok(fit, `${label}: fit expected`);
        assert.strictEqual(
          distanceBetween(fit.position, fit.target),
          vertical * padding,
          `${label} @ aspect ${aspect}: landscape distance must be the vertical-field one exactly`,
        );
      }
      const preset = presetViewTarget(makeState(aspect), 'front', { min: CUBE_MIN, max: CUBE_MAX }, 0);
      assert.strictEqual(
        distanceBetween(preset.position, preset.target),
        vertical * 1.5,
        `preset @ aspect ${aspect}: landscape distance must be the vertical-field one exactly`,
      );
    }
  });
});

describe('zoomExtent keeps a view direction for a degenerate box (#2500)', () => {
  it('does not put the camera on its own target', () => {
    // A single-point AABB — one point-like element, a plan-only model. Zero
    // extent means zero fit distance, so `position` came back equal to
    // `target` and `MathUtils.lookAt` had to invent an entire basis for a
    // pose the fit itself had destroyed.
    const state = makeState(16 / 9);
    const point: Vec3 = { x: 5, y: 5, z: 5 };
    const fit = zoomExtentTarget(state, point, point);
    assert.ok(fit, 'a degenerate box is valid and must still produce a fit');
    assert.deepStrictEqual(fit.target, point, 'the fit must centre on the point');
    const distance = distanceBetween(fit.position, fit.target);
    assert.ok(distance > 1e-6, `position must stay off the target, was ${distance} away`);
    assert.ok(fit.fitDistance > 1e-6, `fitDistance must stay positive, was ${fit.fitDistance}`);
    // The documented behaviour of the degenerate branch: keep the camera's
    // current offset, which is 100 units on this state.
    assert.ok(Math.abs(distance - 100) < 1e-6, `expected the current 100-unit offset, got ${distance}`);
  });

  it('anti-mutation: an ordinary box still fits to the FOV distance, not the current offset', () => {
    const fit = zoomExtentTarget(makeState(16 / 9), CUBE_MIN, CUBE_MAX);
    assert.ok(fit, 'fit expected');
    const expected = (CUBE_SIZE / 2) / Math.tan(FOV / 2) * 1.5;
    assert.ok(
      Math.abs(distanceBetween(fit.position, fit.target) - expected) < 1e-6,
      'a non-degenerate box must still take the FOV path, not the degenerate one',
    );
  });
});

describe('the fit direction floors reject Infinity, not only NaN (#2500)', () => {
  // `len > 1e-10` is false for NaN — which is why these read as guarded — and
  // *true* for Infinity, and `Infinity / Infinity` is NaN. Both floors below
  // read the raw pose, where an overflowed coordinate is reachable: the pose
  // is public mutable state and a restored BCF viewpoint writes it verbatim.
  // The box itself is perfectly usable in both cases, so `isUsableBounds`
  // never sees the problem.
  const OVERFLOWED = { x: Number.POSITIVE_INFINITY, y: 50, z: 100 };

  it('zoomExtent falls back to the isometric direction for an overflowed pose', () => {
    const state = makeState(16 / 9);
    state.camera.position = { ...OVERFLOWED };
    const fit = zoomExtentTarget(state, CUBE_MIN, CUBE_MAX);
    assert.ok(fit, 'the box is usable; the fit must not be rejected for it');
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(Number.isFinite(fit.position[axis]), `position.${axis} was ${fit.position[axis]}`);
    }
  });

  it('frameBounds falls back to the isometric direction for an overflowed pose', () => {
    // A zeroed view matrix is what pushes `frameBoundsTarget` past its primary
    // (view-matrix) direction onto the pose-derived fallback that carries the
    // floor. `MathUtils.lookAt` produces one for a pose it cannot orient from.
    const state = makeState(16 / 9);
    state.viewMatrix = { m: new Float32Array(16) };
    state.camera.position = { ...OVERFLOWED };
    const fit = frameBoundsTarget(state, CUBE_MIN, CUBE_MAX);
    assert.ok(fit, 'the box is usable; the fit must not be rejected for it');
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(Number.isFinite(fit.position[axis]), `position.${axis} was ${fit.position[axis]}`);
    }
  });

  it('anti-mutation: a finite pose still steers both fits', () => {
    // The floors must reject only unusable lengths. If they rejected
    // everything, both fits would silently snap to the isometric fallback and
    // the tests above would pass against a camera that had stopped honouring
    // the view direction at all.
    const zoom = zoomExtentTarget(makeState(16 / 9), CUBE_MIN, CUBE_MAX);
    assert.ok(zoom, 'fit expected');
    // The state looks down -Z, so the fit sits on +Z of the centre.
    assert.ok(Math.abs(zoom.position.x) < 1e-9 && Math.abs(zoom.position.y) < 1e-9,
      `zoomExtent should keep the -Z view direction, got ${JSON.stringify(zoom.position)}`);

    const framedState = makeState(16 / 9);
    framedState.viewMatrix = { m: new Float32Array(16) };
    const framed = frameBoundsTarget(framedState, CUBE_MIN, CUBE_MAX);
    assert.ok(framed, 'fit expected');
    assert.ok(Math.abs(framed.position.x) < 1e-9 && Math.abs(framed.position.y) < 1e-9,
      `frameBounds should fall back to the pose direction, got ${JSON.stringify(framed.position)}`);
  });
});

describe('preset views survive a malformed building rotation (#2500)', () => {
  it('treats a non-finite IfcSite rotation as no rotation', () => {
    const reference = presetViewTarget(makeState(1), 'front', { min: CUBE_MIN, max: CUBE_MAX }, 0);
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      for (const view of ['top', 'bottom', 'front', 'back', 'left', 'right'] as const) {
        const fit = presetViewTarget(makeState(1), view, { min: CUBE_MIN, max: CUBE_MAX }, 0, bad);
        for (const axis of ['x', 'y', 'z'] as const) {
          assert.ok(
            Number.isFinite(fit.position[axis]),
            `${view} @ buildingRotation ${bad}: position.${axis} was ${fit.position[axis]}`,
          );
        }
      }
    }
    // And the substitute is specifically zero, so a malformed placement lands
    // on exactly the pose a model with no site rotation would get.
    const substituted = presetViewTarget(makeState(1), 'front', { min: CUBE_MIN, max: CUBE_MAX }, 0, Number.NaN);
    assert.deepStrictEqual(substituted.position, reference.position);
  });

  it('reaches the same guard through the published Camera.setPresetView', () => {
    // Reachability, not reasoning: `buildingRotation` is a documented third
    // argument of the published API and the viewer sources it from the file's
    // IfcSite placement. Run through the tween so the pose is the one that
    // actually lands, not merely the one that was picked.
    withStubbedFrameClock((advance) => {
      const camera = new Camera();
      camera.setAspect(16 / 9);
      camera.setPosition(50, 50, 100);
      camera.setTarget(0, 0, 0);
      camera.setPresetView('front', { min: CUBE_MIN, max: CUBE_MAX }, Number.NaN);
      advance(301);
      camera.update(16);

      for (const axis of ['x', 'y', 'z'] as const) {
        assert.ok(Number.isFinite(camera.getPosition()[axis]), `position.${axis} was ${camera.getPosition()[axis]}`);
        assert.ok(Number.isFinite(camera.getTarget()[axis]), `target.${axis} was ${camera.getTarget()[axis]}`);
      }
      const m = Array.from(camera.getViewProjMatrix().m);
      const bad = m.findIndex((v) => !Number.isFinite(v));
      assert.strictEqual(bad, -1, `view-projection component ${bad} is ${m[bad]}`);
    });
  });

  it('anti-mutation: a real building rotation is still applied', () => {
    const rotated = presetViewTarget(makeState(1), 'front', { min: CUBE_MIN, max: CUBE_MAX }, 0, Math.PI / 2);
    const unrotated = presetViewTarget(makeState(1), 'front', { min: CUBE_MIN, max: CUBE_MAX }, 0);
    assert.notDeepStrictEqual(
      rotated.position,
      unrotated.position,
      'a finite rotation must still move the preset camera',
    );
  });
});

describe('preset views survive an out-of-range rotation cycle (#2500)', () => {
  it('falls back to the unrotated cycle position rather than indexing past the table', () => {
    // `rotation` is the animator's 0-3 counter today, but it is a plain
    // `number` on the signature: `thetaPerRotation[4]` is `undefined`, and
    // `undefined + x` is NaN — the whole preset pose, not just the angle.
    for (const view of ['top', 'bottom'] as const) {
      for (const bad of [4, -1, 1.5, Number.NaN]) {
        const fit = presetViewTarget(makeState(1), view, { min: CUBE_MIN, max: CUBE_MAX }, bad);
        for (const axis of ['x', 'y', 'z'] as const) {
          assert.ok(
            Number.isFinite(fit.position[axis]),
            `${view} @ rotation ${bad}: position.${axis} was ${fit.position[axis]}`,
          );
        }
      }
    }
  });

  it('anti-mutation: the four real cycle positions still differ from one another', () => {
    const seen = new Set<string>();
    for (const rotation of [0, 1, 2, 3]) {
      const fit = presetViewTarget(makeState(1), 'top', { min: CUBE_MIN, max: CUBE_MAX }, rotation);
      seen.add(`${fit.position.x.toFixed(6)},${fit.position.z.toFixed(6)}`);
    }
    assert.strictEqual(seen.size, 4, 'each ViewCube cycle position must still give a distinct pose');
  });
});
