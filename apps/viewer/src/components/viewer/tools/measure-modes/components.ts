/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Axis breakdown for a point-to-point measurement.
 *
 * Pure display maths: the stored Measurement shape is unchanged, these values
 * are derived on render from its two endpoints.
 *
 * AXIS CONVENTION: viewer space is Y-UP. Geometry is converted from IFC Z-up
 * to WebGL Y-up on import (see packages/renderer/src/camera.ts, `up: {x:0,y:1,z:0}`),
 * so the vertical component is |dy| and the horizontal component is the length
 * of the (dx, dz) ground-plane projection. Using dz as "up" here would be
 * silently wrong for every model.
 */

import { formatDistance } from '../formatDistance';

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

export interface DistanceComponents {
  /** Signed delta along viewer X (east/west in the ground plane). */
  dx: number;
  /** Signed delta along viewer Y (the UP axis). */
  dy: number;
  /** Signed delta along viewer Z (the other ground-plane axis). */
  dz: number;
  /** Ground-plane (horizontal) distance: hypot(dx, dz). Never negative. */
  horizontal: number;
  /** Vertical rise/fall: |dy|. Never negative. */
  vertical: number;
}

/**
 * Break a point-to-point displacement into per-axis deltas plus the
 * horizontal / vertical split. Deltas are signed (end minus start); the
 * horizontal and vertical readouts are magnitudes.
 */
export function distanceComponents(start: Point3, end: Point3): DistanceComponents {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  return {
    dx,
    dy,
    dz,
    // Y is up: the ground plane is X/Z, the vertical axis is Y.
    horizontal: Math.hypot(dx, dz),
    vertical: Math.abs(dy),
  };
}

/**
 * Format a signed delta, keeping the sign in front of the unit-scaled
 * magnitude. `overrides` is the user's LENGTHUNIT display override (#1573,
 * `unitDisplayOverrides`); omitting it (or passing `{}`) keeps the previous
 * auto-scaled-metric behaviour.
 */
export function formatSignedDistance(meters: number, overrides: Record<string, string> = {}): string {
  const magnitude = formatDistance(Math.abs(meters), overrides);
  return meters < 0 ? `-${magnitude}` : magnitude;
}

/** One-line per-axis readout, e.g. `dX 3.000 m  dY 12.000 m  dZ 4.000 m`. */
export function formatAxisDeltas(c: DistanceComponents, overrides: Record<string, string> = {}): string {
  return `dX ${formatSignedDistance(c.dx, overrides)}  dY ${formatSignedDistance(c.dy, overrides)}  dZ ${formatSignedDistance(c.dz, overrides)}`;
}

/** One-line horizontal/vertical readout, e.g. `H 5.000 m  V 12.000 m`. */
export function formatHorizontalVertical(c: DistanceComponents, overrides: Record<string, string> = {}): string {
  return `H ${formatDistance(c.horizontal, overrides)}  V ${formatDistance(c.vertical, overrides)}`;
}
