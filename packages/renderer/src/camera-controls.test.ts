/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import type { Vec3, Camera, Mat4 } from './types.ts';
import { CameraControls, type CameraInternalState } from './camera-controls.ts';
import { CAMERA_CONSTANTS as CC } from './constants.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

function len(v: Vec3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return vec3(a.x - b.x, a.y - b.y, a.z - b.z);
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function approxEqual(a: number, b: number, eps = 1e-6): void {
  assert.ok(
    Math.abs(a - b) < eps,
    `expected ${a} ≈ ${b} (diff=${Math.abs(a - b)})`,
  );
}

/** Angle between two vectors in radians. */
function angleBetween(a: Vec3, b: Vec3): number {
  const d = dot(a, b) / (len(a) * len(b));
  return Math.acos(Math.max(-1, Math.min(1, d)));
}

function makeMat4(): Mat4 {
  return { m: new Float32Array(16) };
}

function makeCamera(pos: Vec3, target: Vec3): Camera {
  return {
    position: { ...pos },
    target: { ...target },
    up: vec3(0, 1, 0),
    fov: Math.PI / 4,
    aspect: 1,
    near: 0.1,
    far: 1000,
  };
}

function makeState(camera: Camera): CameraInternalState {
  return {
    camera,
    viewMatrix: makeMat4(),
    projMatrix: makeMat4(),
    viewProjMatrix: makeMat4(),
    projectionMode: 'perspective',
    orthoSize: 10,
    sceneBounds: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CameraControls – standard orbit', () => {
  let state: CameraInternalState;
  let controls: CameraControls;

  beforeEach(() => {
    // Camera at (0, 10, 20) looking at origin
    state = makeState(makeCamera(vec3(0, 10, 20), vec3(0, 0, 0)));
    controls = new CameraControls(state, () => {});
  });

  it('preserves distance to target after orbit', () => {
    const distBefore = len(sub(state.camera.position, state.camera.target));
    controls.orbit(50, 30);
    const distAfter = len(sub(state.camera.position, state.camera.target));
    approxEqual(distBefore, distAfter, 1e-4);
  });

  it('target stays fixed during standard orbit', () => {
    const tBefore = { ...state.camera.target };
    controls.orbit(100, -50);
    approxEqual(state.camera.target.x, tBefore.x);
    approxEqual(state.camera.target.y, tBefore.y);
    approxEqual(state.camera.target.z, tBefore.z);
  });

  it('horizontal orbit changes theta without changing phi much', () => {
    const posBefore = { ...state.camera.position };
    controls.orbit(100, 0); // purely horizontal
    // Y should stay roughly the same (small drift from sensitivity)
    const dirBefore = sub(posBefore, state.camera.target);
    const dirAfter = sub(state.camera.position, state.camera.target);
    approxEqual(dirAfter.y, dirBefore.y, 0.5);
  });
});

describe('CameraControls – external pivot orbit', () => {
  let state: CameraInternalState;
  let controls: CameraControls;

  beforeEach(() => {
    // Camera at (0, 10, 20) looking at (0, 5, 15)
    // Pivot (orbit center) at (5, 5, 15) — off to the side
    state = makeState(makeCamera(vec3(0, 10, 20), vec3(0, 5, 15)));
    controls = new CameraControls(state, () => {});
    controls.setOrbitCenter(vec3(5, 5, 15));
  });

  it('preserves distance from position to pivot', () => {
    const pivot = vec3(5, 5, 15);
    const distBefore = len(sub(state.camera.position, pivot));
    controls.orbit(50, 30);
    const distAfter = len(sub(state.camera.position, pivot));
    approxEqual(distBefore, distAfter, 1e-4);
  });

  it('preserves look distance (|target - position|)', () => {
    const lookBefore = len(sub(state.camera.target, state.camera.position));
    controls.orbit(50, 30);
    const lookAfter = len(sub(state.camera.target, state.camera.position));
    approxEqual(lookBefore, lookAfter, 1e-4);
  });

  it('does NOT snap target to pivot', () => {
    const pivot = vec3(5, 5, 15);
    controls.orbit(80, -40);
    const targetDist = len(sub(state.camera.target, pivot));
    assert.ok(targetDist > 0.1, `target should not coincide with pivot (dist=${targetDist})`);
  });

  it('vertical orbit direction matches standard orbit convention', () => {
    // Dragging mouse down (deltaY > 0) should move camera UP (toward top pole)
    // = position.y relative to pivot should increase
    const pivot = vec3(5, 5, 15);
    const yRelBefore = state.camera.position.y - pivot.y;
    // Large positive deltaY = drag down
    controls.orbit(0, 200);
    const yRelAfter = state.camera.position.y - pivot.y;
    assert.ok(
      yRelAfter > yRelBefore,
      `dragging down should move camera up: yRel ${yRelBefore} → ${yRelAfter}`,
    );
  });

  it('vertical orbit opposite direction also works', () => {
    // Dragging mouse up (deltaY < 0) should move camera DOWN
    const pivot = vec3(5, 5, 15);
    const yRelBefore = state.camera.position.y - pivot.y;
    controls.orbit(0, -200);
    const yRelAfter = state.camera.position.y - pivot.y;
    assert.ok(
      yRelAfter < yRelBefore,
      `dragging up should move camera down: yRel ${yRelBefore} → ${yRelAfter}`,
    );
  });

  it('does not get stuck at the top pole', () => {
    // First orbit to near the top pole
    for (let i = 0; i < 50; i++) controls.orbit(0, 100);
    const posAfterUp = { ...state.camera.position };

    // Now orbit back down — should actually move
    for (let i = 0; i < 50; i++) controls.orbit(0, -100);
    const posAfterDown = { ...state.camera.position };

    const moved = len(sub(posAfterDown, posAfterUp));
    assert.ok(moved > 1, `camera should move away from pole (moved=${moved})`);
  });

  it('does not get stuck at the bottom pole', () => {
    // Orbit to near the bottom pole
    for (let i = 0; i < 50; i++) controls.orbit(0, -100);
    const posAfterDown = { ...state.camera.position };

    // Now orbit back up — should actually move
    for (let i = 0; i < 50; i++) controls.orbit(0, 100);
    const posAfterUp = { ...state.camera.position };

    const moved = len(sub(posAfterUp, posAfterDown));
    assert.ok(moved > 1, `camera should move away from bottom pole (moved=${moved})`);
  });

  it('look direction never becomes vertical (prevents view matrix flip)', () => {
    // Orbit aggressively in all directions — look should never be within ~0.01 rad of ±Y
    const yAxis = vec3(0, 1, 0);
    for (let i = 0; i < 100; i++) {
      controls.orbit(i % 3 === 0 ? 30 : -30, i % 2 === 0 ? 80 : -80);
      const look = sub(state.camera.target, state.camera.position);
      const angle = angleBetween(look, yAxis);
      assert.ok(
        angle > 0.005 && angle < Math.PI - 0.005,
        `look direction too close to vertical: angle=${angle} at step ${i}`,
      );
    }
  });

  it('horizontal orbit works near the top pole', () => {
    // Move to near the top pole
    for (let i = 0; i < 50; i++) controls.orbit(0, 100);
    const posBefore = { ...state.camera.position };

    // Horizontal orbit should still work
    controls.orbit(200, 0);
    const posAfter = { ...state.camera.position };

    const moved = len(sub(posAfter, posBefore));
    assert.ok(moved > 0.1, `horizontal orbit should work near pole (moved=${moved})`);
  });

  it('camera can look from above (position.y > pivot.y)', () => {
    // Orbit up repeatedly
    for (let i = 0; i < 40; i++) controls.orbit(0, 100);
    const pivot = vec3(5, 5, 15);
    assert.ok(
      state.camera.position.y > pivot.y,
      `camera should be above pivot (y=${state.camera.position.y}, pivot.y=${pivot.y})`,
    );
  });

  it('orbit clamps to upper hemisphere (no flipping under building)', () => {
    // BIM convention: camera can look from straight down to the horizon
    // but never under the model (which would flip the view upside-down).
    // Repeated drag-up orbits should drive phi to MAX_PHI ≈ π/2, not π.
    for (let i = 0; i < 80; i++) controls.orbit(0, -100);
    const pivot = vec3(5, 5, 15);
    assert.ok(
      state.camera.position.y >= pivot.y - 1e-3,
      `camera should NOT dip below pivot (y=${state.camera.position.y}, pivot.y=${pivot.y})`,
    );
  });
});

describe('CameraControls – zoom', () => {
  let state: CameraInternalState;
  let controls: CameraControls;

  beforeEach(() => {
    state = makeState(makeCamera(vec3(0, 10, 20), vec3(0, 0, 0)));
    controls = new CameraControls(state, () => {});
  });

  it('allows zooming in beyond the old hard floor', () => {
    for (let i = 0; i < 220; i++) {
      controls.zoom(-100);
    }

    const distance = len(sub(state.camera.position, state.camera.target));
    assert.ok(
      distance < 0.001,
      `camera should zoom closer than the old 0.001 limit (distance=${distance})`,
    );
    assert.ok(
      distance >= CC.MIN_PERSPECTIVE_DISTANCE,
      `camera should still respect the minimum zoom floor (distance=${distance})`,
    );
  });
});

describe('CameraControls – pan', () => {
  it('moves both position and target by the same offset', () => {
    const state = makeState(makeCamera(vec3(0, 10, 20), vec3(0, 0, 0)));
    const controls = new CameraControls(state, () => {});
    const lookBefore = sub(state.camera.target, state.camera.position);
    controls.pan(5, 3);
    const lookAfter = sub(state.camera.target, state.camera.position);
    approxEqual(lookBefore.x, lookAfter.x, 1e-4);
    approxEqual(lookBefore.y, lookAfter.y, 1e-4);
    approxEqual(lookBefore.z, lookAfter.z, 1e-4);
  });

  it('pans in top-down view (camera straight above target)', () => {
    // Top preset view: camera at (0, 100, 0) looking down, screen-up = -Z.
    const state = makeState(makeCamera(vec3(0, 100, 0), vec3(0, 0, 0)));
    state.camera.up = vec3(0, 0, -1);
    const controls = new CameraControls(state, () => {});
    const posBefore = { ...state.camera.position };
    const targetBefore = { ...state.camera.target };

    controls.pan(10, 5);

    const dx = state.camera.position.x - posBefore.x;
    const dy = state.camera.position.y - posBefore.y;
    const dz = state.camera.position.z - posBefore.z;
    const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
    assert.ok(moved > 1e-4, `pan should produce motion in top view (moved=${moved})`);

    // Position and target move by the same offset (pure pan).
    approxEqual(state.camera.target.x - targetBefore.x, dx, 1e-6);
    approxEqual(state.camera.target.y - targetBefore.y, dy, 1e-6);
    approxEqual(state.camera.target.z - targetBefore.z, dz, 1e-6);
  });
});

describe('CameraControls – orbit from preset top view (BIM convention)', () => {
  // Pattern (yomotsu/camera-controls, Autodesk Viewer, ThatOpen):
  // setPresetView('top') positions the camera at phi=MIN_PHI (just barely
  // off the +Y pole) with camera.up = (0,1,0). Orbit is then standard
  // spherical with no special pole handling. Phi is clamped to the upper
  // hemisphere [MIN_PHI, π/2−ε] — the camera can look from straight down to
  // the horizon but cannot flip under the building.

  function setupTopPreset(): { state: CameraInternalState; controls: CameraControls } {
    // Approximate what setPresetView('top') produces: camera just barely
    // off the +Y pole (theta=0 in this test → camera slightly to +Z, so
    // screen-up after lookAt with Y-up is +Z direction).
    const dist = 100;
    const poleOffset = Math.sin(0.01) * dist;
    const verticalOffset = Math.cos(0.01) * dist;
    const state = makeState(makeCamera(
      vec3(0, verticalOffset, poleOffset),
      vec3(0, 0, 0),
    ));
    state.camera.up = vec3(0, 1, 0);
    const controls = new CameraControls(state, () => {});
    controls.setOrbitCenter(vec3(0, 0, 0));
    return { state, controls };
  }

  it('camera.up stays world Y after orbit (BIM Y-up preserved)', () => {
    const { state, controls } = setupTopPreset();
    controls.orbit(50, -50);
    approxEqual(state.camera.up.x, 0, 1e-6);
    approxEqual(state.camera.up.y, 1, 1e-6);
    approxEqual(state.camera.up.z, 0, 1e-6);
  });

  it('drag-up at top view tilts camera smoothly toward the horizon', () => {
    const { state, controls } = setupTopPreset();
    const phiBefore = Math.acos(state.camera.position.y / len(state.camera.position));

    // Drag-up: deltaY < 0 → dy > 0 → phi increases toward MAX_PHI.
    controls.orbit(0, -50);

    const phiAfter = Math.acos(state.camera.position.y / len(state.camera.position));
    assert.ok(
      phiAfter > phiBefore,
      `phi should increase on drag-up (before=${phiBefore}, after=${phiAfter})`,
    );
    // No X drift: camera was on the YZ plane (theta=0), should stay there.
    approxEqual(state.camera.position.x, 0, 1e-4);
  });

  it('repeated drag-up converges to horizon (not over the top)', () => {
    const { state, controls } = setupTopPreset();
    for (let i = 0; i < 80; i++) controls.orbit(0, -100);
    const phi = Math.acos(state.camera.position.y / len(state.camera.position));
    assert.ok(
      phi <= CC.MAX_PHI + 1e-4,
      `phi must be clamped at MAX_PHI (got ${phi}, max ${CC.MAX_PHI})`,
    );
    assert.ok(
      state.camera.position.y >= -1e-3,
      `camera must not dip below target y (y=${state.camera.position.y})`,
    );
  });

  it('continuous drag stays on a single axis (no mid-orbit jump)', () => {
    const { state, controls } = setupTopPreset();
    controls.orbit(0, -10);
    const x1 = state.camera.position.x;
    controls.orbit(0, -10);
    const x2 = state.camera.position.x;
    controls.orbit(0, -10);
    const x3 = state.camera.position.x;
    // Pure vertical drag should never introduce X drift across frames.
    approxEqual(x1, 0, 1e-4);
    approxEqual(x2, 0, 1e-4);
    approxEqual(x3, 0, 1e-4);
  });

});
