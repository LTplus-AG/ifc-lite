/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CoordinateInfo, Vec3 } from '@ifc-lite/geometry';

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Convert an IFC Z-up coordinate to the viewer's Y-up axes. `0 - value`
 * deliberately normalises either sign of zero only on the negated axis.
 */
export function ifcToViewerAxes(point: Readonly<Vec3>): Vec3 {
  return { x: point.x, y: point.z, z: 0 - point.y };
}

/** Convert viewer Y-up to IFC Z-up with the same negated-axis zero rule. */
export function viewerToIfcAxes(point: Readonly<Vec3>): Vec3 {
  return { x: point.x, y: 0 - point.z, z: point.y };
}

/**
 * Total translation from the render frame to world coordinates, in viewer
 * Y-up axes. `originShift` is already Y-up; `wasmRtcOffset` is IFC Z-up.
 */
export function totalYupOffset(
  info?: Pick<CoordinateInfo, 'originShift' | 'wasmRtcOffset'> | null,
): Vec3 {
  const shift = info?.originShift ?? ZERO;
  const rtcYup = ifcToViewerAxes(info?.wasmRtcOffset ?? ZERO);
  return {
    x: (shift.x + rtcYup.x),
    y: (shift.y + rtcYup.y),
    z: (shift.z + rtcYup.z),
  };
}
