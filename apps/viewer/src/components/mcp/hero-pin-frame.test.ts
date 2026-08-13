/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * That `visible` answers for the whole frustum, not just for depth (#2453).
 *
 * Two oracles, and the second is what keeps the first honest:
 *
 * 1. A SWEEP of the authored hero scene. The BCF-pin step orbits a fixed pin
 *    with `autoRotate` on, so the interesting states are reached by the page
 *    itself within seconds — no user input required. Sampling a full
 *    revolution at the real camera distance is therefore a faithful model of
 *    what the hero does, and the depth-only predicate calls the pin visible on
 *    every one of those samples including the ones where it has left the frame
 *    sideways. Measured on the authored constants: 178 of 720 azimuths, peak
 *    |ndc.x| = 1.087.
 * 2. A camera where the pin never leaves the frame (`cameraDefault`, peak
 *    |ndc.x| = 0.795), which must still report visible on all 720 samples.
 *    Without it, "return false more often" would pass the first oracle.
 *
 * The exact boundary is then pinned separately against an orthographic camera
 * whose NDC x equals world x, so ±1 and ±(1 + ε) can be stated exactly rather
 * than approached.
 *
 * Scene constants are a snapshot of the authored hero (`hero-scene-building.ts`
 * — pin at (2.6, 1.9, FRONT_Z + 0.1) with FRONT_Z = D/2 + 0.001, D = 5 — and
 * `hero-scene-steps.ts`, step 10's `cameraTarget`). If they drift, the
 * reachability assertions below fail loudly rather than going quiet, which is
 * the failure mode to want: re-measure and update the numbers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { projectPinFrame } from './hero-pin-frame.js';
import { STOREY } from './hero-scene-building.js';

/** The hero's BCF pin, in world space. */
const PIN = new THREE.Vector3(2.6, 1.9, 5 / 2 + 0.001 + 0.1);
/** `OrbitControls.target` in `createScene`. */
const ORBIT_TARGET = new THREE.Vector3(0, STOREY, 0);
/** The stage is `aspect-[4/5]`; any size with that ratio gives the same NDC. */
const STAGE_W = 480;
const STAGE_H = 600;
const SAMPLES = 720;

/** The camera `createScene` builds, aimed from `position` at the orbit target. */
function heroCamera(position: THREE.Vector3): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(35, STAGE_W / STAGE_H, 0.1, 100);
  camera.position.copy(position);
  camera.lookAt(ORBIT_TARGET);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return camera;
}

interface Sample {
  ndc: THREE.Vector3;
  /** What `projectPin()` reports today. */
  visible: boolean;
  /** What it reported before the fix: depth alone. */
  depthOnlyVisible: boolean;
}

/** One full `autoRotate` revolution from `start`, sampled `SAMPLES` times. */
function sweepOrbit(start: [number, number, number]): Sample[] {
  const spherical = new THREE.Spherical().setFromVector3(
    new THREE.Vector3(...start).sub(ORBIT_TARGET),
  );
  const out: Sample[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const at = new THREE.Vector3().setFromSpherical(new THREE.Spherical(
      spherical.radius, spherical.phi, spherical.theta + (i / SAMPLES) * Math.PI * 2,
    )).add(ORBIT_TARGET);
    const camera = heroCamera(at);
    const ndc = PIN.clone().project(camera);
    const frame = projectPinFrame(PIN, camera, STAGE_W, STAGE_H);
    assert.ok(frame, 'a sized stage must never project to null');
    out.push({ ndc, visible: frame.visible, depthOnlyVisible: ndc.z >= -1 && ndc.z <= 1 });
  }
  return out;
}

describe('hero pin projection: visible means inside the frustum (#2453)', () => {
  it('stops reporting visible while the BCF-pin step has orbited the pin out of frame', () => {
    // Step 10 — the one step that fades the pin in and renders the caption.
    const samples = sweepOrbit([9.5, 4, 10]);
    const escaped = samples.filter((s) => Math.abs(s.ndc.x) > 1);

    // Reachability first: if the scene ever stops putting the pin off-frame,
    // every assertion below would hold vacuously.
    assert.ok(escaped.length > 100, `the pin must leave the frame on this step (got ${escaped.length}/${SAMPLES})`);
    assert.ok(
      Math.max(...samples.map((s) => Math.abs(s.ndc.x))) > 1.05,
      'and overshoot the edge by a margin no rounding could explain',
    );
    // The defect, stated as a control: depth alone called every one of these
    // visible, so `HeroOverlay` placed the caption at `x + 22` off-canvas.
    assert.ok(escaped.every((s) => s.depthOnlyVisible), 'control: the old predicate saw all of them as visible');

    assert.ok(escaped.every((s) => !s.visible), 'a pin outside the lateral bounds is not visible');
    assert.ok(
      samples.filter((s) => s.visible).every((s) => Math.abs(s.ndc.x) <= 1 && Math.abs(s.ndc.y) <= 1),
      'nothing reported visible may sit outside the frustum',
    );
  });

  it('still reports visible for every angle of an orbit that keeps the pin in frame', () => {
    // Anti-mutation. `cameraDefault` peaks at |ndc.x| = 0.795, so any predicate
    // tighter than the true frustum — a safety margin, a hard-coded 0.75, an
    // accidental sign flip — starts hiding a caption that belongs on screen and
    // this fails.
    const samples = sweepOrbit([12, 8, 13]);
    assert.equal(samples.filter((s) => s.visible).length, SAMPLES, 'the pin never leaves this frame');
    assert.ok(
      Math.max(...samples.map((s) => Math.abs(s.ndc.x))) < 1,
      'fixture check: this camera is the in-frame control',
    );
  });

  it('places the frustum edge exactly at |ndc| == 1, and excludes anything past it', () => {
    // An orthographic camera spanning [-1, 1] makes NDC x equal world x, so
    // the boundary can be stated rather than approached.
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const visible = (x: number, y: number, z = 0) =>
      projectPinFrame(new THREE.Vector3(x, y, z), camera, STAGE_W, STAGE_H)?.visible;

    // Inclusive on purpose: the pin is a world-space sprite with extent, so at
    // exactly the edge its centre is on the boundary and half of it is drawn.
    assert.equal(visible(1, 0), true, 'the right edge is on screen');
    assert.equal(visible(-1, 0), true, 'so is the left');
    assert.equal(visible(0, 1), true, 'and the top');
    assert.equal(visible(0, -1), true, 'and the bottom');

    // One part in a million past it is off screen — an over-broad predicate
    // (bounds of 1.1, or a `< 1.5` fudge) fails here.
    assert.equal(visible(1.000001, 0), false, 'a hair past the right edge is not');
    assert.equal(visible(0, -1.000001), false, 'nor past the bottom');
    assert.equal(visible(0.999999, 0.999999), true, 'a hair inside still is');

    // Depth is still part of it — the half that already worked.
    assert.equal(visible(0, 0, 6), false, 'behind the camera stays invisible');
  });

  it('reports the position of an off-frustum pin rather than returning null (#2446)', () => {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const frame = projectPinFrame(new THREE.Vector3(3, 0, 0), camera, STAGE_W, STAGE_H);
    assert.ok(frame, 'out-of-frustum is reported through `visible`, never by returning null');
    assert.equal(frame.visible, false);
    assert.equal(Number.isFinite(frame.x) && Number.isFinite(frame.y), true, 'x/y are filled in, and meaningless');

    // `null` has exactly one cause: no coordinate space to project into.
    assert.equal(projectPinFrame(new THREE.Vector3(0, 0, 0), camera, 0, STAGE_H), null);
    assert.equal(projectPinFrame(new THREE.Vector3(0, 0, 0), camera, STAGE_W, 0), null);
  });

  it('maps NDC into host pixels with y pointing down', () => {
    // The overlay anchors to these numbers with CSS `left` / `top`, so the
    // flip matters as much as the visibility flag.
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const centre = projectPinFrame(new THREE.Vector3(0, 0, 0), camera, STAGE_W, STAGE_H);
    assert.deepEqual([centre?.x, centre?.y], [STAGE_W / 2, STAGE_H / 2]);

    const top = projectPinFrame(new THREE.Vector3(0, 1, 0), camera, STAGE_W, STAGE_H);
    assert.equal(top?.y, 0, 'the top of NDC is y = 0 in CSS pixels');
  });
});
