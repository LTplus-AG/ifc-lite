/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Country-neutral map types shared by the model reading and, later, the
 * hazard check. Nothing here knows about Switzerland.
 */

/** A point in a projected map CRS: easting `x`, northing `y`, in metres. */
export interface MapPoint {
  x: number;
  y: number;
}

/** An axis-aligned box in a projected map CRS, in metres. */
export interface MapBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
