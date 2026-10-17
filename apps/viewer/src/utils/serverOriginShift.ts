/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ifcToViewerAxes } from '@ifc-lite/geometry/world-frame';

/**
 * The server's `coordinate_info.origin_shift` as a `CoordinateInfo.originShift`.
 *
 * The server ships its meshes Y-up (`apps/server/src/services/axis.rs`) but
 * leaves `origin_shift` in the Z-up IFC axes it was subtracted in, while
 * `CoordinateInfo.originShift` is documented, and read by every consumer, in
 * the Y-up mesh axes. Adding the raw triple to Y-up bounds mixed the axes for
 * any RTC model (#7734); this is the one place the server's value changes
 * axes.
 */
export function serverOriginShift(
  originShift: readonly [number, number, number] | undefined,
): { x: number; y: number; z: number } {
  if (!originShift) return { x: 0, y: 0, z: 0 };
  return ifcToViewerAxes({ x: originShift[0], y: originShift[1], z: originShift[2] });
}
