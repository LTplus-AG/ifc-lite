/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `unprojectToRay` turns a cursor position into a world-space ray, and that
 * ray leaves the package: picking, measurement, the floor-plane unprojection
 * and the Cesium placement editor all consume it. A ray that is merely *wrong*
 * shows up on screen; a ray whose origin is `(NaN, NaN, NaN)` does not, because
 * consumers test a hit with a comparison (`t < tMin`, `dist < tolerance`) and
 * every comparison against NaN is false. The user sees "clicked empty space".
 *
 * The orthographic branch used to build its own screen basis with
 * `normalize(cross(forward, up))`. `MathUtils.normalize` floored on
 * `len < 1e-10` at the time, which is false for NaN, so it divided by NaN
 * instead of falling back — and Infinity got through the other way, since
 * `Infinity * (1 / Infinity)` is NaN. Both flavours returned a NaN origin
 * while `MathUtils.lookAt`, given the *same* `up`, produced a perfectly finite
 * view matrix from a deterministic substitute basis (#2467).
 *
 * That mismatch is what decides the design question the issue left open —
 * `null` versus a fallback. The frame on screen is built from `lookAt`'s
 * substitute, so the ray must be too, or picking disagrees with the picture
 * the user is clicking on. `viewBasis` is now the single source of
 * both, and these tests pin that they cannot drift apart.
 *
 * Scope: the returned-value side. The pose-writing gestures live in
 * `camera-malformed-pose-navigation.test.ts`, the projection matrix in
 * `camera-degenerate-pose-matrix.test.ts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { Camera } from './camera.js';
import { MathUtils, viewBasis} from './math.js';
import type { Vec3 } from './types.js';

/**
 * Off-centre by construction. At the exact canvas centre both NDC terms are
 * zero, the whole basis-dependent offset drops out, and every `up` — good or
 * malformed — produces an identical origin. That blinded the first probe on
 * #2463 and would make every assertion in this file vacuous.
 */
const CURSOR = { x: 700, y: 100, w: 800, h: 600 };

/** Dead centre, where the basis genuinely does not matter. Used as a control. */
const CENTRE = { x: 400, y: 300, w: 800, h: 600 };

function assertVecFinite(v: Vec3, label: string): void {
  for (const axis of ['x', 'y', 'z'] as const) {
    assert.ok(Number.isFinite(v[axis]), `${label}: ${axis} is ${v[axis]}`);
  }
}

function cameraWithUp(up: Vec3, mode: 'perspective' | 'orthographic'): Camera {
  const camera = new Camera();
  camera.setAspect(16 / 9);
  camera.setPosition(50, 50, 100);
  camera.setTarget(0, 0, 0);
  camera.setUp(up.x, up.y, up.z);
  if (mode === 'orthographic') camera.setProjectionMode(mode);
  return camera;
}

/**
 * Both non-finite flavours in each component, because they did not behave
 * alike under the old magnitude floor: NaN failed `len < 1e-10` by being
 * incomparable, Infinity passed it and then poisoned the scale. A guard
 * written `!Number.isNaN(...)` would satisfy half of this list.
 */
const MALFORMED_UPS: Vec3[] = [
  { x: Number.NaN, y: 1, z: 0 },
  { x: 0, y: Number.NaN, z: 0 },
  { x: 0, y: 1, z: Number.NaN },
  { x: Infinity, y: 1, z: 0 },
  { x: 0, y: Infinity, z: 0 },
  { x: 0, y: 1, z: -Infinity },
];

describe('unprojectToRay returns a usable ray for a malformed basis (#2467)', () => {
  it('a non-finite up gives a finite ray in both projection modes', () => {
    for (const mode of ['orthographic', 'perspective'] as const) {
      for (const up of MALFORMED_UPS) {
        const camera = cameraWithUp(up, mode);
        const ray = camera.unprojectToRay(CURSOR.x, CURSOR.y, CURSOR.w, CURSOR.h);
        const label = `${mode} up=${JSON.stringify(up)}`;
        assertVecFinite(ray.origin, `${label} origin`);
        assertVecFinite(ray.direction, `${label} direction`);
        // A zero-length direction is the other silent miss: it hits nothing.
        const len = Math.hypot(ray.direction.x, ray.direction.y, ray.direction.z);
        assert.ok(len > 0.5, `${label}: direction length is ${len}`);
      }
    }
  });

  it('the ray uses the same basis the view matrix is built from', () => {
    // The substance of the fix. `lookAt` substitutes a deterministic basis for
    // an unusable `up`; if the ray were derived from anything else — a raw
    // world-Y fallback, say — picking would disagree with the rendered frame
    // in a way no test of finiteness alone would catch.
    for (const up of MALFORMED_UPS) {
      const camera = cameraWithUp(up, 'orthographic');
      const basis = viewBasis(camera.getPosition(), camera.getTarget(), camera.getUp());
      const ray = camera.unprojectToRay(CURSOR.x, CURSOR.y, CURSOR.w, CURSOR.h);

      const label = `up=${JSON.stringify(up)}`;
      assert.deepStrictEqual(ray.direction, basis.forward, `${label}: direction must be the view forward`);

      // Reconstruct the origin from the shared basis and require an exact match.
      const halfH = camera.getOrthoSize();
      const halfW = halfH * (16 / 9);
      const ndcX = (CURSOR.x / CURSOR.w) * 2 - 1;
      const ndcY = 1 - (CURSOR.y / CURSOR.h) * 2;
      const expected = {
        x: basis.eye.x + basis.right.x * ndcX * halfW + basis.up.x * ndcY * halfH,
        y: basis.eye.y + basis.right.y * ndcX * halfW + basis.up.y * ndcY * halfH,
        z: basis.eye.z + basis.right.z * ndcX * halfW + basis.up.z * ndcY * halfH,
      };
      assert.deepStrictEqual(ray.origin, expected, `${label}: origin must come from the shared basis`);
    }
  });

  it('a malformed up genuinely changes the answer at an off-centre cursor', () => {
    // Guards against the whole suite being vacuous. If the off-centre origin
    // matched the centred one, the basis-dependent term would be dropping out
    // and every assertion above would hold for any implementation at all.
    const camera = cameraWithUp({ x: Infinity, y: 1, z: 0 }, 'orthographic');
    const offCentre = camera.unprojectToRay(CURSOR.x, CURSOR.y, CURSOR.w, CURSOR.h);
    const centred = camera.unprojectToRay(CENTRE.x, CENTRE.y, CENTRE.w, CENTRE.h);
    assert.notDeepStrictEqual(
      offCentre.origin, centred.origin,
      'an off-centre cursor must produce a different ray origin than a centred one',
    );
  });

  it('anti-mutation: a well-formed up is used verbatim, not replaced', () => {
    // `viewBasis` must only substitute when `up` carries no usable
    // orientation. A rolled camera is a legitimate pose, and if the fallback
    // fired for it the ray would silently ignore the roll — the "plausible
    // but quietly wrong" outcome the issue warns measurement about.
    const rolled = cameraWithUp({ x: 0.6, y: 0.8, z: 0 }, 'orthographic');
    const upright = cameraWithUp({ x: 0, y: 1, z: 0 }, 'orthographic');
    assert.notDeepStrictEqual(
      rolled.unprojectToRay(CURSOR.x, CURSOR.y, CURSOR.w, CURSOR.h).origin,
      upright.unprojectToRay(CURSOR.x, CURSOR.y, CURSOR.w, CURSOR.h).origin,
      'a rolled camera must produce a rolled ray',
    );
  });

  it('anti-mutation: a short but valid up is not treated as degenerate', () => {
    // `up` is stored unnormalized and BCF restore writes it verbatim, so a
    // legitimately short `up` is a reachable input whose direction is
    // perfectly well defined. A length floor here would silently swap the
    // caller's roll for the fallback.
    const tiny = cameraWithUp({ x: 1e-8, y: 1e-8, z: 0 }, 'orthographic');
    const same = cameraWithUp({ x: 1, y: 1, z: 0 }, 'orthographic');
    const a = tiny.unprojectToRay(CURSOR.x, CURSOR.y, CURSOR.w, CURSOR.h).origin;
    const b = same.unprojectToRay(CURSOR.x, CURSOR.y, CURSOR.w, CURSOR.h).origin;
    // Approximate: the two differ only by the rounding of a 1e-8 normalization,
    // which is exactly the point — the fallback would move the origin by tens
    // of world units, not by an ulp.
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(
        Math.abs(a[axis] - b[axis]) < 1e-6,
        `scaling up must not change the ray: ${axis} ${a[axis]} vs ${b[axis]}`,
      );
    }
  });

  it('a zero-extent canvas gives the centre ray rather than an infinite one', () => {
    // `Renderer.resize` now floors this, but the drawing buffer is public
    // state an embedder can zero directly, and `screen / 0` is +-Infinity —
    // or NaN when the cursor is at 0 too, since `0 / 0` is NaN. A viewport
    // with no extent has no cursor position, so dead centre is the honest
    // reading (#2473).
    for (const mode of ['orthographic', 'perspective'] as const) {
      const camera = cameraWithUp({ x: 0, y: 1, z: 0 }, mode);
      for (const [w, h] of [[0, 600], [800, 0], [0, 0], [Number.NaN, 600], [-800, 600]]) {
        const ray = camera.unprojectToRay(700, 100, w, h);
        const label = `${mode} canvas ${w}x${h}`;
        assertVecFinite(ray.origin, `${label} origin`);
        assertVecFinite(ray.direction, `${label} direction`);
      }
      // ...and the degradation is specifically "centre", not "arbitrary".
      const collapsed = camera.unprojectToRay(700, 100, 0, 0);
      const centred = camera.unprojectToRay(CENTRE.x, CENTRE.y, CENTRE.w, CENTRE.h);
      assert.deepStrictEqual(collapsed.origin, centred.origin, `${mode}: collapsed canvas must read as centre`);
    }
  });

  it('anti-mutation: a healthy canvas is not mistaken for a collapsed one', () => {
    // If the extent guard were over-broad the anchored ray would collapse to
    // the centre everywhere, and the finiteness assertions above would all
    // still pass while picking pointed at the middle of the screen.
    const camera = cameraWithUp({ x: 0, y: 1, z: 0 }, 'orthographic');
    assert.notDeepStrictEqual(
      camera.unprojectToRay(CURSOR.x, CURSOR.y, CURSOR.w, CURSOR.h).origin,
      camera.unprojectToRay(CENTRE.x, CENTRE.y, CENTRE.w, CENTRE.h).origin,
      'a healthy canvas must still anchor the ray to the cursor',
    );
  });

  it('a non-finite camera position gives the ray the rendered frame belongs to', () => {
    // The perspective branch returned `{...camera.position}` raw, so a
    // malformed pose produced a NaN origin there too — while the view
    // matrix's translation row used the scrubbed eye. Same drift, same fix.
    //
    // Finiteness alone would not pin the fix: any substitute eye at all — the
    // world origin, the target — is finite, and picking would then disagree
    // with the rendered frame just as loudly, only without a NaN to show for
    // it. So each mode is checked against the value the *shared basis* gives,
    // reconstructed with the same arithmetic the orthographic case uses above.
    for (const mode of ['orthographic', 'perspective'] as const) {
      const camera = cameraWithUp({ x: 0, y: 1, z: 0 }, mode);
      camera.setPosition(Number.NaN, 50, 100);
      const basis = viewBasis(camera.getPosition(), camera.getTarget(), camera.getUp());
      const ray = camera.unprojectToRay(CURSOR.x, CURSOR.y, CURSOR.w, CURSOR.h);
      assertVecFinite(ray.origin, `${mode} NaN position origin`);
      assertVecFinite(ray.direction, `${mode} NaN position direction`);

      if (mode === 'orthographic') {
        // Parallel rays: the direction IS the view forward, and the origin is
        // the scrubbed eye offset along the basis by the cursor's NDC.
        assert.deepStrictEqual(
          ray.direction, basis.forward,
          'NaN position: the orthographic direction must be the view forward',
        );
        const halfH = camera.getOrthoSize();
        const halfW = halfH * (16 / 9);
        const ndcX = (CURSOR.x / CURSOR.w) * 2 - 1;
        const ndcY = 1 - (CURSOR.y / CURSOR.h) * 2;
        assert.deepStrictEqual(ray.origin, {
          x: basis.eye.x + basis.right.x * ndcX * halfW + basis.up.x * ndcY * halfH,
          y: basis.eye.y + basis.right.y * ndcX * halfW + basis.up.y * ndcY * halfH,
          z: basis.eye.z + basis.right.z * ndcX * halfW + basis.up.z * ndcY * halfH,
        }, 'NaN position: the orthographic origin must come from the scrubbed eye');
      } else {
        // Perspective rays all leave the eye, so the origin is the scrubbed
        // eye exactly. The direction is a genuine unprojection through the
        // cursor — deliberately NOT the view forward, which the control below
        // pins — so it is checked for being a unit vector aimed into the
        // frame rather than reconstructed from the inverse matrix, which
        // would only restate the implementation.
        assert.deepStrictEqual(
          ray.origin, { ...basis.eye },
          'NaN position: the perspective origin must be the scrubbed eye',
        );
        const len = Math.hypot(ray.direction.x, ray.direction.y, ray.direction.z);
        assert.ok(Math.abs(len - 1) < 1e-9, `NaN position: direction length is ${len}`);
        const alongView = ray.direction.x * basis.forward.x
          + ray.direction.y * basis.forward.y
          + ray.direction.z * basis.forward.z;
        assert.ok(alongView > 0.5, `NaN position: direction points away from the frame (dot ${alongView})`);
        assert.notDeepStrictEqual(
          ray.direction, basis.forward,
          'NaN position: an off-centre perspective ray must not collapse onto the view forward',
        );
      }
    }
  });

  it('a saturated inverse matrix gives the centre ray rather than a NaN one', () => {
    // The last member of the family, and it is in the *perspective* branch:
    // `MathUtils.invert` stores its result in a `Float32Array`, so an inverse
    // component past 3.4e38 saturates to `Infinity`, `transformPoint` carries
    // that into `worldPoint`, and `normalize` used to divide by an infinite
    // length — `Infinity / Infinity` is NaN while the finite components go to
    // a clean `0`. The direction came back `{NaN, 0, -0}`: not finite, and
    // not the zero vector the fallback below tests for, so it escaped both.
    //
    // Measured on the pose below, which is finite throughout — no NaN and no
    // Infinity is ever written to the camera. That is the point: this one is
    // reached from values every existing guard in the family accepts (#2479).
    const camera = new Camera();
    camera.setAspect(4);
    camera.setPosition(1e155, 0, 0);
    camera.setTarget(0, 0, 0);
    camera.setUp(0, 1, 0);
    const basis = viewBasis(camera.getPosition(), camera.getTarget(), camera.getUp());
    const ray = camera.unprojectToRay(CURSOR.x, CURSOR.y, CURSOR.w, CURSOR.h);

    assertVecFinite(ray.direction, 'saturated inverse direction');
    assert.deepStrictEqual(
      ray.direction, basis.forward,
      'a direction that cannot be normalized must fall back to the view forward',
    );
    const len = Math.hypot(ray.direction.x, ray.direction.y, ray.direction.z);
    assert.ok(len > 0.5, `saturated inverse: direction length is ${len}`);
  });

  it('anti-mutation: an ordinary perspective ray is not the view forward', () => {
    // Pins the fallback above as a fallback. If `unprojectToRay` returned the
    // view forward unconditionally, every assertion in this file about the
    // perspective branch would still hold and cursor-anchored picking would
    // point at the middle of the screen for every click.
    const camera = cameraWithUp({ x: 0, y: 1, z: 0 }, 'perspective');
    const basis = viewBasis(camera.getPosition(), camera.getTarget(), camera.getUp());
    assert.notDeepStrictEqual(
      camera.unprojectToRay(CURSOR.x, CURSOR.y, CURSOR.w, CURSOR.h).direction,
      basis.forward,
      'a healthy off-centre cursor must produce its own direction',
    );
  });

  it('a non-finite orthoSize does not reach the ray origin', () => {
    // `updateMatrices` backstops `orthoSize` for the projection matrix; this
    // is the other reader of the same field (#2461).
    const camera = cameraWithUp({ x: 0, y: 1, z: 0 }, 'orthographic');
    camera.setOrthoSize(Number.NaN);
    assertVecFinite(
      camera.unprojectToRay(CURSOR.x, CURSOR.y, CURSOR.w, CURSOR.h).origin,
      'NaN orthoSize origin',
    );
  });
});

/**
 * The primitive underneath the ray. `MathUtils.normalize` is published from
 * this package, and its floor was the last `>`/`<` magnitude test in the
 * family: a lower bound rejects NaN (every comparison is false) but *admits*
 * Infinity, which is not below it. These pin the contract the fallback in
 * `unprojectToRay` now leans on — that the only non-unit result is the zero
 * vector — so a future edit cannot quietly reintroduce a third outcome.
 */
describe('MathUtils.normalize is total (#2479)', () => {
  it('every non-finite input degrades to the zero vector', () => {
    const zero = { x: 0, y: 0, z: 0 };
    const inputs: Vec3[] = [
      { x: Infinity, y: 1, z: 0 },   // the escaping shape: NaN/0/0 before the fix
      { x: 1, y: -Infinity, z: 0 },
      { x: 0, y: 1, z: Infinity },
      { x: Number.NaN, y: 1, z: 0 },
      { x: 0, y: Number.NaN, z: 0 },
      { x: Infinity, y: Infinity, z: Infinity },
      { x: Number.NaN, y: Number.NaN, z: Number.NaN },
    ];
    for (const v of inputs) {
      assert.deepStrictEqual(
        MathUtils.normalize(v), zero,
        `normalize(${JSON.stringify(v)}) must be the zero vector`,
      );
    }
  });

  it('a whole-vector overflow keeps degrading to the zero vector', () => {
    // `1e200 * 1e200` is already `Infinity`, so the *length* overflows while
    // every component stays finite. That case reached the zero vector before
    // the fix too (finite / Infinity is 0), and must keep doing so — it is
    // the reason the callers test for zero at all.
    assert.deepStrictEqual(
      MathUtils.normalize({ x: 1e200, y: 1e200, z: 1e200 }),
      { x: 0, y: 0, z: 0 },
    );
  });

  it('anti-mutation: ordinary and very short vectors still normalize', () => {
    // A guard written as "reject anything unusual" would swallow these. The
    // 1e-9 vector is above the 1e-10 floor and has a perfectly well-defined
    // direction; `up` is stored unnormalized, so short vectors are real.
    assert.deepStrictEqual(MathUtils.normalize({ x: 0, y: 2, z: 0 }), { x: 0, y: 1, z: 0 });
    const tiny = MathUtils.normalize({ x: 1e-9, y: 0, z: 0 });
    assert.deepStrictEqual(tiny, { x: 1, y: 0, z: 0 });
    // ...and the documented degenerate case is unchanged.
    assert.deepStrictEqual(MathUtils.normalize({ x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 0 });
    assert.deepStrictEqual(MathUtils.normalize({ x: 1e-11, y: 0, z: 0 }), { x: 0, y: 0, z: 0 });
  });
});
