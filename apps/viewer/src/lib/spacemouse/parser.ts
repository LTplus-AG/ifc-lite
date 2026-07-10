/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure 3Dconnexion HID report parser.
 *
 * Takes a raw HID input report (reportId + DataView, exactly what a WebHID
 * `inputreport` event provides) and folds it into a typed 6DoF state. It is
 * intentionally free of any browser / device handles so it can be unit-tested
 * with synthetic bytes.
 *
 * Layouts handled:
 *   - Split: reportId 1 carries 3 int16 translation values, reportId 2 carries
 *     3 int16 rotation values. Each report updates only its own three axes; the
 *     others carry over from the previous state.
 *   - Combined: reportId 1 with >=12 bytes carries all six axes
 *     (tx, ty, tz, rx, ry, rz).
 * A truncated buffer never throws: axes without enough bytes keep their
 * previous value.
 */

import {
  AXIS_FULL_SCALE,
  REPORT_ID_ROTATION,
  REPORT_ID_TRANSLATION,
} from './constants.js';

/** Raw (clamped) 6DoF sample. Units are device counts in [-AXIS_FULL_SCALE, +AXIS_FULL_SCALE]. */
export interface SixDof {
  /** Translation, left/right (positive = cap pushed right). */
  tx: number;
  /** Translation, in/out (positive = cap pulled toward the user). */
  ty: number;
  /** Translation, up/down (positive = cap pressed down). */
  tz: number;
  /** Rotation about the x axis (tilt cap forward/back). */
  rx: number;
  /** Rotation about the y axis (roll cap side to side). */
  ry: number;
  /** Rotation about the z axis (twist cap). */
  rz: number;
}

/** All-zero 6DoF state, the neutral resting sample. */
export function zeroSixDof(): SixDof {
  return { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
}

/** Clamp a raw axis reading to the device's full-scale window. */
export function clampAxis(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > AXIS_FULL_SCALE) return AXIS_FULL_SCALE;
  if (value < -AXIS_FULL_SCALE) return -AXIS_FULL_SCALE;
  return value;
}

/**
 * Read a signed 16-bit little-endian axis at `offset`, or `null` when the
 * buffer is too short (truncated report). Never throws.
 */
function readAxis(data: DataView, offset: number): number | null {
  if (offset + 2 > data.byteLength) return null;
  return clampAxis(data.getInt16(offset, true));
}

/**
 * Fold one HID report into a new 6DoF state. Pure: returns a fresh object and
 * never mutates `prev`. Unknown report ids (e.g. buttons) return `prev`
 * unchanged (a shallow copy), so a caller can always trust the result.
 */
export function parseSpaceMouseReport(reportId: number, data: DataView, prev: SixDof): SixDof {
  const next: SixDof = { ...prev };

  if (reportId === REPORT_ID_TRANSLATION) {
    const tx = readAxis(data, 0);
    const ty = readAxis(data, 2);
    const tz = readAxis(data, 4);
    if (tx !== null) next.tx = tx;
    if (ty !== null) next.ty = ty;
    if (tz !== null) next.tz = tz;

    // Combined 12-byte layout: rotation rides along in the same frame.
    if (data.byteLength >= 12) {
      const rx = readAxis(data, 6);
      const ry = readAxis(data, 8);
      const rz = readAxis(data, 10);
      if (rx !== null) next.rx = rx;
      if (ry !== null) next.ry = ry;
      if (rz !== null) next.rz = rz;
    }
    return next;
  }

  if (reportId === REPORT_ID_ROTATION) {
    const rx = readAxis(data, 0);
    const ry = readAxis(data, 2);
    const rz = readAxis(data, 4);
    if (rx !== null) next.rx = rx;
    if (ry !== null) next.ry = ry;
    if (rz !== null) next.rz = rz;
    return next;
  }

  // Buttons or any other report id: no 6DoF change.
  return next;
}

/**
 * Extract pressed button indices from a reportId-3 buttons bitmask. Byte 0
 * carries buttons 0..7, byte 1 buttons 8..15, and so on. Returns indices in
 * ascending order.
 */
export function parseButtonsReport(data: DataView): number[] {
  const pressed: number[] = [];
  for (let byteIndex = 0; byteIndex < data.byteLength; byteIndex++) {
    const byte = data.getUint8(byteIndex);
    if (byte === 0) continue;
    for (let bit = 0; bit < 8; bit++) {
      if (byte & (1 << bit)) pressed.push(byteIndex * 8 + bit);
    }
  }
  return pressed;
}
