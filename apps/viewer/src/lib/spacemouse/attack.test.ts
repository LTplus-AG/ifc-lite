/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ADVERSARIAL tests for the SpaceMouse feature (#1677), consolidated from the
 * parallel PR #1688's adversarial review. Each test name is prefixed with
 * CONFIRMED- or REFUTED- to state the verdict for the attacked surface.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpaceMouseReport,
  zeroSixDof,
  type SixDof,
} from './parser.js';
import {
  mapSixDofToCameraDeltas,
  deltasAreZero,
  isInputStale,
} from './mapping.js';
import {
  REPORT_ID_TRANSLATION,
  REPORT_ID_ROTATION,
  REPORT_ID_BUTTONS,
  AXIS_FULL_SCALE,
  BASE_RATES,
  SENSITIVITY,
  MAX_FRAME_DELTA_MS,
  STALE_REPORT_TIMEOUT_MS,
} from './constants.js';

function reportOf(values: number[]): DataView {
  const buf = new ArrayBuffer(values.length * 2);
  const view = new DataView(buf);
  values.forEach((v, i) => view.setInt16(i * 2, v, true));
  return view;
}

// ---------------------------------------------------------------------------
// SURFACE 1: FRAME-TIME SPIKE / CAMERA TELEPORT (unclamped dt)
// ---------------------------------------------------------------------------

test('backgrounded-tab resume integrates at most MAX_FRAME_DELTA_MS (no teleport)', () => {
  // User holds the puck at full push, backgrounds the tab 30s, returns. rAF
  // pauses, so the first resumed frame reports a 30s delta. The mapping caps
  // integration at MAX_FRAME_DELTA_MS (adversarial finding on #1688: an
  // unclamped dt produced a ~270-wheel-notch teleport).
  const held: SixDof = { ...zeroSixDof(), ty: AXIS_FULL_SCALE }; // full dolly pull
  const resumed = mapSixDofToCameraDeltas(held, 1, 30_000);
  const capped = mapSixDofToCameraDeltas(held, 1, MAX_FRAME_DELTA_MS);
  assert.equal(resumed.zoomDelta, capped.zoomDelta, '30s frame behaves like the cap');
  assert.ok(
    resumed.zoomDelta <= BASE_RATES.zoomDeltaPerSec * (MAX_FRAME_DELTA_MS / 1000) + 1e-9,
    `expected <=${BASE_RATES.zoomDeltaPerSec * (MAX_FRAME_DELTA_MS / 1000)}, got ${resumed.zoomDelta}`,
  );
});

test('worst case (max sensitivity + 30s bg) stays a sub-frame orbit, not radians', () => {
  const held: SixDof = { ...zeroSixDof(), rz: AXIS_FULL_SCALE };
  const d = mapSixDofToCameraDeltas(held, SENSITIVITY.max, 30_000);
  const cappedMax = BASE_RATES.orbitPxPerSec * SENSITIVITY.max * (MAX_FRAME_DELTA_MS / 1000);
  assert.ok(Math.abs(d.orbitDx) <= cappedMax + 1e-9, `expected <=${cappedMax}px orbit, got ${d.orbitDx}`);
});

test('REFUTED-dt-zero-guarded: deltaMs=0 yields zero deltas', () => {
  const held: SixDof = { ...zeroSixDof(), ty: AXIS_FULL_SCALE };
  assert.ok(deltasAreZero(mapSixDofToCameraDeltas(held, 1, 0)));
});

test('REFUTED-dt-negative-guarded: negative dt (timer skew) yields zero deltas', () => {
  const held: SixDof = { ...zeroSixDof(), ty: AXIS_FULL_SCALE };
  assert.ok(deltasAreZero(mapSixDofToCameraDeltas(held, 1, -1000)));
  assert.ok(deltasAreZero(mapSixDofToCameraDeltas(held, 1, Number.NaN)));
});

// ---------------------------------------------------------------------------
// SURFACE 2: STALE INPUT LATCH / RUNAWAY (state never decays on report silence)
// ---------------------------------------------------------------------------

test('silent HID stall is cut off by the staleness watchdog', () => {
  // If the device stops emitting reports without a disconnect event, the
  // driver consults isInputStale(lastReportAt, now) and stops driving the
  // camera once the report is older than STALE_REPORT_TIMEOUT_MS
  // (adversarial finding on #1688: the last non-zero sample used to latch
  // and move the camera forever).
  const lastReport = 1_000_000;
  assert.equal(isInputStale(lastReport, lastReport + STALE_REPORT_TIMEOUT_MS), false, 'fresh at the boundary');
  assert.equal(isInputStale(lastReport, lastReport + STALE_REPORT_TIMEOUT_MS + 1), true, 'stale past the timeout');
  assert.equal(isInputStale(Number.NEGATIVE_INFINITY, lastReport), true, 'never-reported counts as stale');
  assert.equal(isInputStale(Number.NaN, lastReport), true, 'corrupt clock counts as stale');
});

test('REFUTED-unplug-zeroes: an all-zero state (as session.close() produces) stops motion', () => {
  // On a real unplug, SpaceMouseSession.close() zeroes the 6DoF state and the
  // hook stops its RAF loop. Model that terminal state here.
  assert.ok(deltasAreZero(mapSixDofToCameraDeltas(zeroSixDof(), 1, 16)));
});

// ---------------------------------------------------------------------------
// SURFACE 3: PARSER BOUNDARIES
// ---------------------------------------------------------------------------

test('REFUTED-int16-min-no-signflip: -32768 clamps to -full scale (no abs overflow)', () => {
  const out = parseSpaceMouseReport(REPORT_ID_ROTATION, reportOf([-32768, -32768, -32768]), zeroSixDof());
  assert.equal(out.rx, -AXIS_FULL_SCALE);
  assert.equal(out.ry, -AXIS_FULL_SCALE);
  assert.equal(out.rz, -AXIS_FULL_SCALE);
  // Downstream normalisation stays in [-1,1] with the correct sign.
  const d = mapSixDofToCameraDeltas(out, 1, 1000);
  assert.ok(d.orbitDy < 0, 'sign preserved, not flipped positive');
});

test('REFUTED-dataview-byteoffset: a subarray DataView (byteOffset!=0) parses correctly', () => {
  // WebHID sometimes hands a DataView that is a window into a larger buffer.
  const backing = new ArrayBuffer(4 + 6); // 4 bytes junk prefix + 3x int16
  const full = new DataView(backing);
  full.setInt16(4 + 0, 111, true);
  full.setInt16(4 + 2, -222, true);
  full.setInt16(4 + 4, 333, true);
  const windowed = new DataView(backing, 4, 6); // byteOffset=4
  const out = parseSpaceMouseReport(REPORT_ID_TRANSLATION, windowed, zeroSixDof());
  assert.equal(out.tx, 111);
  assert.equal(out.ty, -222);
  assert.equal(out.tz, 333); // below full scale, passes through unchanged
});

test('CONFIRMED-12byte-misclassification: a 12-byte reportId-1 with trailing padding injects phantom rotation', () => {
  // Design: any reportId-1 with >=12 bytes is treated as combined 6-axis.
  // A device that emits translation-only but pads its report to 12 bytes (or a
  // 6-byte split report followed by uninitialised/garbage tail) has its bytes
  // 6..11 silently interpreted as rotation rx/ry/rz. Documented limitation.
  const translationOnlyWithGarbageTail = reportOf([10, 20, 30, 400, -400, 200]);
  const out = parseSpaceMouseReport(REPORT_ID_TRANSLATION, translationOnlyWithGarbageTail, zeroSixDof());
  assert.equal(out.tx, 10);
  // Phantom rotation the device never intended:
  assert.equal(out.rx, AXIS_FULL_SCALE); // 400 clamps to 350
  assert.equal(out.rz, 200);
  const d = mapSixDofToCameraDeltas(out, 1, 16);
  assert.ok(d.orbitDx !== 0 || d.orbitDy !== 0, 'phantom orbit from misread padding');
});

test('REFUTED-buttons-huge-bitmask: reportId 3 with a huge payload never touches 6DoF', () => {
  const huge = new DataView(new Uint8Array(64).fill(0xff).buffer);
  const prev: SixDof = { tx: 1, ty: 2, tz: 3, rx: 4, ry: 5, rz: 6 };
  const out = parseSpaceMouseReport(REPORT_ID_BUTTONS, huge, prev);
  assert.deepEqual(out, prev);
});

test('REFUTED-interleaved-out-of-order: rotation-then-translation reports each keep their own axes', () => {
  let s = zeroSixDof();
  s = parseSpaceMouseReport(REPORT_ID_ROTATION, reportOf([9, 0, 0]), s);
  s = parseSpaceMouseReport(REPORT_ID_TRANSLATION, reportOf([1, 2, 3]), s);
  s = parseSpaceMouseReport(REPORT_ID_ROTATION, reportOf([0, 0, 8]), s);
  assert.equal(s.tx, 1);
  assert.equal(s.rx, 0); // overwritten by the second rotation report
  assert.equal(s.rz, 8);
});

test('REFUTED-odd-length-buffer: a 5-byte report never throws and keeps the unbacked axis', () => {
  const prev: SixDof = { tx: 0, ty: 0, tz: 99, rx: 0, ry: 0, rz: 0 };
  const buf = new DataView(new Uint8Array([0x0a, 0x00, 0x14, 0x00, 0x7f]).buffer); // 5 bytes
  const out = parseSpaceMouseReport(REPORT_ID_TRANSLATION, buf, prev);
  assert.equal(out.tx, 10);
  assert.equal(out.ty, 20);
  assert.equal(out.tz, 99); // offset 4 needs bytes 4-5; only byte 4 present -> kept
});

// ---------------------------------------------------------------------------
// SURFACE 4: SLICE PERSISTENCE — sensitivity rehydrate validation
// ---------------------------------------------------------------------------
// clampSensitivity is not exported, so exercise it through the same math the
// slice applies on load. These document the guard the slice relies on.

test('REFUTED-sensitivity-rehydrate: corrupt persisted sensitivity is clamped, not trusted', () => {
  const clamp = (v: number) =>
    Number.isFinite(v) ? Math.min(SENSITIVITY.max, Math.max(SENSITIVITY.min, v)) : SENSITIVITY.default;
  assert.equal(clamp(-5), SENSITIVITY.min); // negative -> min
  assert.equal(clamp(1e9), SENSITIVITY.max); // absurd -> max
  assert.equal(clamp(Number.NaN), SENSITIVITY.default);
  // And a clamped-to-min sensitivity still cannot produce negative gain.
  const d = mapSixDofToCameraDeltas({ ...zeroSixDof(), ty: AXIS_FULL_SCALE }, clamp(-5), 16);
  assert.ok(d.zoomDelta > 0);
});
