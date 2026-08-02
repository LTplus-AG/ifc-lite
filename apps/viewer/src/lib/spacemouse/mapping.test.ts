/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDeadzone,
  mapSixDofToCameraDeltas,
  deltasAreZero,
} from './mapping.js';
import { zeroSixDof, type SixDof } from './parser.js';
import { AXIS_FULL_SCALE, AXIS_SIGN, BASE_RATES, DEADZONE_FRACTION, MAX_FRAME_DELTA_MS } from './constants.js';

// One frame at the integration cap: full deflection for exactly this long
// yields rate * CAP_DT of mouse-equivalent delta.
const CAP_DT = MAX_FRAME_DELTA_MS / 1000;

test('applyDeadzone returns 0 inside the dead zone', () => {
  const inside = AXIS_FULL_SCALE * DEADZONE_FRACTION * 0.5;
  assert.equal(applyDeadzone(inside), 0);
  assert.equal(applyDeadzone(-inside), 0);
  assert.equal(applyDeadzone(0), 0);
});

test('applyDeadzone ramps from 0 at the edge to 1 at full scale', () => {
  // Just past the dead zone edge is near 0, not a jump to a large value.
  const edge = AXIS_FULL_SCALE * DEADZONE_FRACTION;
  assert.ok(Math.abs(applyDeadzone(edge + 0.001)) < 1e-3);
  // Full scale maps to exactly 1 / -1.
  assert.equal(applyDeadzone(AXIS_FULL_SCALE), 1);
  assert.equal(applyDeadzone(-AXIS_FULL_SCALE), -1);
});

test('applyDeadzone is monotonic and sign-preserving outside the dead zone', () => {
  const half = applyDeadzone(AXIS_FULL_SCALE * 0.5);
  const full = applyDeadzone(AXIS_FULL_SCALE);
  assert.ok(half > 0 && half < full);
  assert.ok(applyDeadzone(-AXIS_FULL_SCALE * 0.5) < 0);
});

test('idle (all-zero) sample produces zero deltas', () => {
  const d = mapSixDofToCameraDeltas(zeroSixDof(), 1, 16);
  assert.ok(deltasAreZero(d));
});

test('non-positive deltaMs or sensitivity produces zero deltas', () => {
  const full: SixDof = { tx: AXIS_FULL_SCALE, ty: AXIS_FULL_SCALE, tz: AXIS_FULL_SCALE, rx: AXIS_FULL_SCALE, ry: 0, rz: AXIS_FULL_SCALE };
  assert.ok(deltasAreZero(mapSixDofToCameraDeltas(full, 1, 0)));
  assert.ok(deltasAreZero(mapSixDofToCameraDeltas(full, 0, 16)));
  assert.ok(deltasAreZero(mapSixDofToCameraDeltas(full, -1, 16)));
});

test('cap left/right (tx) drives horizontal pan only', () => {
  // Full deflection on tx only, sensitivity 1, one frame at the dt cap.
  const s: SixDof = { ...zeroSixDof(), tx: AXIS_FULL_SCALE };
  const d = mapSixDofToCameraDeltas(s, 1, MAX_FRAME_DELTA_MS);
  assert.equal(d.panDx, AXIS_SIGN.panX * BASE_RATES.panPxPerSec * CAP_DT);
  assert.equal(d.panDy, 0);
  assert.equal(d.zoomDelta, 0);
  assert.equal(d.orbitDx, 0);
  assert.equal(d.orbitDy, 0);
});

test('cap up/down (tz) drives vertical pan only', () => {
  const s: SixDof = { ...zeroSixDof(), tz: AXIS_FULL_SCALE };
  const d = mapSixDofToCameraDeltas(s, 1, MAX_FRAME_DELTA_MS);
  assert.equal(d.panDy, AXIS_SIGN.panY * BASE_RATES.panPxPerSec * CAP_DT);
  assert.equal(d.panDx, 0);
  assert.equal(d.zoomDelta, 0);
});

test('cap push/pull (ty) drives zoom with the configured sign', () => {
  const s: SixDof = { ...zeroSixDof(), ty: AXIS_FULL_SCALE };
  const d = mapSixDofToCameraDeltas(s, 1, MAX_FRAME_DELTA_MS);
  assert.equal(d.zoomDelta, AXIS_SIGN.dolly * BASE_RATES.zoomDeltaPerSec * CAP_DT);
  assert.equal(d.panDx, 0);
  assert.equal(d.panDy, 0);
  assert.equal(d.orbitDx, 0);
});

test('twist (rz) and tilt (rx) drive orbit; roll (ry) is ignored', () => {
  const s: SixDof = { ...zeroSixDof(), rz: AXIS_FULL_SCALE, rx: AXIS_FULL_SCALE, ry: AXIS_FULL_SCALE };
  const d = mapSixDofToCameraDeltas(s, 1, MAX_FRAME_DELTA_MS);
  assert.equal(d.orbitDx, AXIS_SIGN.orbitYaw * BASE_RATES.orbitPxPerSec * CAP_DT);
  assert.equal(d.orbitDy, AXIS_SIGN.orbitPitch * BASE_RATES.orbitPxPerSec * CAP_DT);
  // roll contributes to nothing
  assert.equal(d.panDx, 0);
  assert.equal(d.panDy, 0);
  assert.equal(d.zoomDelta, 0);
});

test('sensitivity scales deltas linearly', () => {
  const s: SixDof = { ...zeroSixDof(), tx: AXIS_FULL_SCALE };
  const base = mapSixDofToCameraDeltas(s, 1, 16);
  const doubled = mapSixDofToCameraDeltas(s, 2, 16);
  assert.ok(Math.abs(doubled.panDx - 2 * base.panDx) < 1e-9);
});

test('deltas scale with frame time (frame-rate independence)', () => {
  const s: SixDof = { ...zeroSixDof(), tx: AXIS_FULL_SCALE };
  const at16 = mapSixDofToCameraDeltas(s, 1, 16);
  const at32 = mapSixDofToCameraDeltas(s, 1, 32);
  assert.ok(Math.abs(at32.panDx - 2 * at16.panDx) < 1e-9);
});

test('a sample entirely within the dead zone yields zero deltas', () => {
  const tiny = AXIS_FULL_SCALE * DEADZONE_FRACTION * 0.5;
  const s: SixDof = { tx: tiny, ty: -tiny, tz: tiny, rx: -tiny, ry: tiny, rz: tiny };
  assert.ok(deltasAreZero(mapSixDofToCameraDeltas(s, 1, 16)));
});
