/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AXIS_FULL_SCALE,
  AXIS_SIGN,
  BASE_RATES,
  DEADZONE_FRACTION,
  FIT_BUTTON_INDICES,
  HID_USAGE_MULTI_AXIS_CONTROLLER,
  HID_USAGE_PAGE_GENERIC_DESKTOP,
  MAX_FRAME_DELTA_MS,
  REPORT_ID_BUTTONS,
  REPORT_ID_ROTATION,
  REPORT_ID_TRANSLATION,
  SENSITIVITY,
  SPACEMOUSE_VENDOR_IDS,
  STALE_REPORT_TIMEOUT_MS,
} from './constants.js';

/**
 * Pins the constants that have a source of truth OUTSIDE this repository.
 *
 * Why this file exists: every other spacemouse test derives its expected value
 * from the same constant it is exercising --
 *
 *   descriptor.test.ts:123   assert.equal(state.tx, AXIS_FULL_SCALE);
 *   mapping.test.ts:58       assert.equal(d.panDx, AXIS_SIGN.panX * BASE_RATES.panPxPerSec * CAP_DT);
 *
 * -- so the assertion and the code move together, and the suite proves the
 * arithmetic around a constant rather than the constant itself.
 *
 * Measured, not assumed. Mutating AXIS_FULL_SCALE 350 -> 300 DOES fail 12
 * existing tests, because `descriptor.test.ts:297` and `parser.test.ts:73`
 * feed raw literals (700, 525, 350, 400) that stop agreeing once the scale
 * moves. That is a collision with a fixture literal rather than a deliberate
 * pin, but it is real coverage and this file does not claim otherwise.
 *
 * The values with NO coverage at all are the ones no test so much as names:
 * the vendor ids, the two HID usage codes and the fit-button set. Mutating
 * all three at once leaves the package at 57/57 green. They are also the
 * values that decide whether the device is ever recognised: device.ts:49
 * builds the WebHID filter from them and device.ts:73 picks the collection.
 *
 * The repo has already shipped what an unpinned table costs: an SI-prefix map
 * holding 4 of 16 entries read `.MICRO.` as metres, a factor of a million,
 * silently. A vendor id fails even quieter -- one wrong hex digit and the
 * device is simply never offered, with no error anywhere.
 *
 * So each assertion below states its value INDEPENDENTLY, from the external
 * spec named beside it. Never rewrite one of these by copying what the code
 * currently returns; that turns the pin back into a mirror.
 */

test('USB vendor ids match the USB-IF assignments', () => {
  // USB-IF vendor ids: 0x046D Logitech (SpaceNavigator / SpaceMouse Pro /
  // SpacePilot), 0x256F 3Dconnexion (Compact / Wireless / Enterprise).
  // device.ts:49 builds the WebHID request filter straight from this list, so
  // a wrong id makes the device unselectable with no diagnostic at all.
  assert.deepEqual([...SPACEMOUSE_VENDOR_IDS], [0x046d, 0x256f]);
});

test('HID usage identifies a multi-axis controller', () => {
  // USB HID Usage Tables: Generic Desktop page = 0x01, and within it
  // Multi-axis Controller = 0x08. device.ts:73 picks the collection to listen
  // on by matching both, so a wrong pair silently yields no input reports.
  assert.equal(HID_USAGE_PAGE_GENERIC_DESKTOP, 0x01);
  assert.equal(HID_USAGE_MULTI_AXIS_CONTROLLER, 0x08);
});

test('report ids follow the 3Dconnexion protocol', () => {
  // 3Dconnexion HID reports: 1 = translation, 2 = rotation, 3 = buttons.
  // Swapping 1 and 2 would route rotation into the translation axes, and the
  // parser tests would not notice: they name the report by constant.
  assert.equal(REPORT_ID_TRANSLATION, 1);
  assert.equal(REPORT_ID_ROTATION, 2);
  assert.equal(REPORT_ID_BUTTONS, 3);
});

test('axis full scale is the documented saturation magnitude', () => {
  // 3Dconnexion axes saturate near +/-350; normalisation divides by this, so
  // a smaller value saturates the camera early and a larger one makes the
  // puck feel dead. Changing it already fails a dozen tests elsewhere, but on
  // literals buried in report fixtures -- this states the value and its
  // source once, where a reader can check it.
  assert.equal(AXIS_FULL_SCALE, 350);
});

test('fit-view is bound to the two physical buttons', () => {
  // SpaceNavigator / Compact / Wireless expose two buttons, reported at
  // indices 0 and 1; device.ts:159 fires "fit view" for these. Nothing else
  // in the package names this set.
  assert.deepEqual([...FIT_BUTTON_INDICES].sort(), [0, 1]);
});

/*
 * The remaining constants are tuning values with no external source of truth.
 * Pinning their literals would assert nothing beyond "it is what it is" and
 * would fail every deliberate retune. What they DO have is invariants --
 * relationships that must hold whatever the values are tuned to -- and those
 * are worth asserting, because breaking one is a defect rather than a retune.
 */

test('the frame cap sits inside the staleness window', () => {
  // A frame may never integrate for longer than the window after which input
  // is abandoned: if MAX_FRAME_DELTA_MS grew past STALE_REPORT_TIMEOUT_MS,
  // the teleport guard would admit motion the staleness guard has already
  // decided is not there. Nothing enforces the ordering today.
  assert.ok(
    MAX_FRAME_DELTA_MS < STALE_REPORT_TIMEOUT_MS,
    `frame cap ${MAX_FRAME_DELTA_MS}ms must stay under the ${STALE_REPORT_TIMEOUT_MS}ms staleness window`,
  );
  // A deflected device streams at ~125Hz, i.e. one report every 8ms. The
  // timeout has to clear several intervals or ordinary jitter reads as a
  // stall, and stay well under a second or a real stall latches the camera.
  assert.ok(STALE_REPORT_TIMEOUT_MS > 4 * 8, 'timeout must clear several 125Hz report intervals');
  assert.ok(STALE_REPORT_TIMEOUT_MS < 1000, 'a stalled device must be released within a second');
});

test('the dead zone silences drift without eating the travel', () => {
  // At 0 the puck's resting noise drives the camera; at 1 the device is
  // entirely dead. Both ends are silent failures, and mapping.test.ts probes
  // the boundary as AXIS_FULL_SCALE * DEADZONE_FRACTION, so it follows the
  // value wherever it goes.
  assert.ok(DEADZONE_FRACTION > 0 && DEADZONE_FRACTION < 0.5, 'dead zone must be a small positive fraction');
});

test('every axis sign is a direction, never a gain', () => {
  // AXIS_SIGN is documented as best-effort and trivially flippable, so the
  // DIRECTIONS are deliberately not pinned: inverting one is a legitimate
  // edit. The magnitude is not. mapping.ts:88 multiplies by these, so 0 would
  // silently disable an axis and 2 would smuggle in a hidden rate multiplier
  // that no review of BASE_RATES would ever see.
  for (const [axis, sign] of Object.entries(AXIS_SIGN)) {
    assert.ok(sign === 1 || sign === -1, `AXIS_SIGN.${axis} must be +1 or -1, got ${sign}`);
  }
});

test('the sensitivity range brackets its own default', () => {
  // The slider clamps to [min, max] and falls back to default; if default
  // fell outside the range, a NaN input would be clamped to a value the
  // slider itself cannot represent.
  assert.ok(SENSITIVITY.min > 0, 'a zero or negative floor would freeze the device');
  assert.ok(SENSITIVITY.min < SENSITIVITY.default, 'default must sit strictly inside the range');
  assert.ok(SENSITIVITY.default < SENSITIVITY.max, 'default must sit strictly inside the range');
  assert.ok(SENSITIVITY.step > 0 && SENSITIVITY.step <= SENSITIVITY.max - SENSITIVITY.min);
});

test('every base rate drives its axis forward', () => {
  // Rates are calibrated by feel, so the numbers are not pinned. A zero would
  // silently disable orbit, pan or zoom, and a negative one is a direction
  // flip that belongs in AXIS_SIGN instead, where it is visible.
  for (const [name, rate] of Object.entries(BASE_RATES)) {
    assert.ok(Number.isFinite(rate) && rate > 0, `BASE_RATES.${name} must be finite and positive, got ${rate}`);
  }
});
