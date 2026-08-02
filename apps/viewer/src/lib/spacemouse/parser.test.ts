/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpaceMouseReport,
  parseButtonsReport,
  clampAxis,
  zeroSixDof,
  type SixDof,
} from './parser.js';
import {
  REPORT_ID_TRANSLATION,
  REPORT_ID_ROTATION,
  REPORT_ID_BUTTONS,
  AXIS_FULL_SCALE,
} from './constants.js';

/** Build a DataView holding the given int16 values, little-endian. */
function reportOf(values: number[]): DataView {
  const buf = new ArrayBuffer(values.length * 2);
  const view = new DataView(buf);
  values.forEach((v, i) => view.setInt16(i * 2, v, true));
  return view;
}

/** Build a DataView from raw bytes (for odd-length / truncated cases). */
function bytesOf(bytes: number[]): DataView {
  return new DataView(new Uint8Array(bytes).buffer);
}

test('all-zero translation report yields zero state', () => {
  const out = parseSpaceMouseReport(REPORT_ID_TRANSLATION, reportOf([0, 0, 0]), zeroSixDof());
  assert.deepEqual(out, zeroSixDof());
});

test('split translation report updates only translation axes', () => {
  const prev: SixDof = { tx: 0, ty: 0, tz: 0, rx: 11, ry: 22, rz: 33 };
  const out = parseSpaceMouseReport(REPORT_ID_TRANSLATION, reportOf([5, -6, 7]), prev);
  assert.equal(out.tx, 5);
  assert.equal(out.ty, -6);
  assert.equal(out.tz, 7);
  // rotation carries over untouched
  assert.equal(out.rx, 11);
  assert.equal(out.ry, 22);
  assert.equal(out.rz, 33);
});

test('split rotation report updates only rotation axes', () => {
  const prev: SixDof = { tx: 1, ty: 2, tz: 3, rx: 0, ry: 0, rz: 0 };
  const out = parseSpaceMouseReport(REPORT_ID_ROTATION, reportOf([-9, 10, -11]), prev);
  assert.equal(out.rx, -9);
  assert.equal(out.ry, 10);
  assert.equal(out.rz, -11);
  // translation carries over untouched
  assert.equal(out.tx, 1);
  assert.equal(out.ty, 2);
  assert.equal(out.tz, 3);
});

test('combined 12-byte report updates all six axes in one frame', () => {
  const out = parseSpaceMouseReport(
    REPORT_ID_TRANSLATION,
    reportOf([1, 2, 3, 4, 5, 6]),
    zeroSixDof(),
  );
  assert.deepEqual(out, { tx: 1, ty: 2, tz: 3, rx: 4, ry: 5, rz: 6 });
});

test('extreme positive values clamp to +full scale', () => {
  const out = parseSpaceMouseReport(REPORT_ID_TRANSLATION, reportOf([32767, 350, 400]), zeroSixDof());
  assert.equal(out.tx, AXIS_FULL_SCALE);
  assert.equal(out.ty, AXIS_FULL_SCALE); // exactly at limit stays
  assert.equal(out.tz, AXIS_FULL_SCALE); // 400 > 350 clamps
});

test('extreme negative values clamp to -full scale', () => {
  const out = parseSpaceMouseReport(REPORT_ID_ROTATION, reportOf([-32768, -350, -351]), zeroSixDof());
  assert.equal(out.rx, -AXIS_FULL_SCALE);
  assert.equal(out.ry, -AXIS_FULL_SCALE);
  assert.equal(out.rz, -AXIS_FULL_SCALE);
});

test('clampAxis maps non-finite readings to a safe 0 and clamps finite ones', () => {
  // Non-finite readings are treated as "no input" (0) rather than full-scale,
  // so a spurious NaN/Infinity can never drive a runaway camera move.
  assert.equal(clampAxis(Number.NaN), 0);
  assert.equal(clampAxis(Number.POSITIVE_INFINITY), 0);
  assert.equal(clampAxis(Number.NEGATIVE_INFINITY), 0);
  assert.equal(clampAxis(120), 120);
  assert.equal(clampAxis(9999), AXIS_FULL_SCALE);
  assert.equal(clampAxis(-9999), -AXIS_FULL_SCALE);
});

test('truncated translation buffer does not throw and keeps missing axes', () => {
  const prev: SixDof = { tx: 100, ty: 200, tz: 300, rx: 0, ry: 0, rz: 0 };
  // Only 3 bytes: enough for tx (offset 0), not ty (offset 2 needs bytes 2-3).
  const out = parseSpaceMouseReport(REPORT_ID_TRANSLATION, bytesOf([0x0a, 0x00, 0x7f]), prev);
  assert.equal(out.tx, 10); // 0x000a LE
  assert.equal(out.ty, 200); // untouched, only one byte available at offset 2
  assert.equal(out.tz, 300); // untouched
});

test('empty buffer never throws and returns previous state', () => {
  const prev: SixDof = { tx: 1, ty: 2, tz: 3, rx: 4, ry: 5, rz: 6 };
  const out = parseSpaceMouseReport(REPORT_ID_TRANSLATION, bytesOf([]), prev);
  assert.deepEqual(out, prev);
});

test('button report leaves 6DoF unchanged', () => {
  const prev: SixDof = { tx: 1, ty: 2, tz: 3, rx: 4, ry: 5, rz: 6 };
  const out = parseSpaceMouseReport(REPORT_ID_BUTTONS, bytesOf([0x01]), prev);
  assert.deepEqual(out, prev);
  assert.notEqual(out, prev); // fresh object, prev not mutated
});

test('unknown report id leaves 6DoF unchanged', () => {
  const prev: SixDof = { tx: 7, ty: 8, tz: 9, rx: 0, ry: 0, rz: 0 };
  const out = parseSpaceMouseReport(99, reportOf([1, 2, 3]), prev);
  assert.deepEqual(out, prev);
});

test('parser never mutates the previous state object', () => {
  const prev = zeroSixDof();
  const frozen = Object.freeze({ ...prev });
  const out = parseSpaceMouseReport(REPORT_ID_TRANSLATION, reportOf([5, 5, 5]), frozen);
  assert.deepEqual(frozen, zeroSixDof()); // prev unchanged
  assert.equal(out.tx, 5);
});

test('parseButtonsReport decodes single and multi-byte bitmasks', () => {
  assert.deepEqual(parseButtonsReport(bytesOf([])), []);
  assert.deepEqual(parseButtonsReport(bytesOf([0x00, 0x00])), []);
  assert.deepEqual(parseButtonsReport(bytesOf([0x01])), [0]);
  assert.deepEqual(parseButtonsReport(bytesOf([0x02])), [1]);
  assert.deepEqual(parseButtonsReport(bytesOf([0x03])), [0, 1]);
  // Byte 1 carries buttons 8..15.
  assert.deepEqual(parseButtonsReport(bytesOf([0x00, 0x81])), [8, 15]);
  // Mixed across bytes, ascending order.
  assert.deepEqual(parseButtonsReport(bytesOf([0x80, 0x01])), [7, 8]);
});
