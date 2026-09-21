/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CoordinateInfo } from '@ifc-lite/geometry';

/** Adopt destination render metadata for a spatial source with no mesh vertices. */
export function emptyAlignedCoordinateInfo(
  source: CoordinateInfo,
  reference: CoordinateInfo | undefined,
): CoordinateInfo {
  return {
    ...structuredClone(source),
    originShift: structuredClone(reference?.originShift ?? { x: 0, y: 0, z: 0 }),
    hasLargeCoordinates: reference?.hasLargeCoordinates ?? false,
    wasmRtcOffset: reference?.wasmRtcOffset ? structuredClone(reference.wasmRtcOffset) : undefined,
    buildingRotation: reference?.buildingRotation,
  };
}
