/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Pure bounds helpers for the bounded federated LandXML stream plan. */

import type { Bounds3D } from '../../utils/localParsingUtils.js';

export function mergeBounds(target: Bounds3D, source: Bounds3D): void {
  target.min.x = Math.min(target.min.x, source.min.x);
  target.min.y = Math.min(target.min.y, source.min.y);
  target.min.z = Math.min(target.min.z, source.min.z);
  target.max.x = Math.max(target.max.x, source.max.x);
  target.max.y = Math.max(target.max.y, source.max.y);
  target.max.z = Math.max(target.max.z, source.max.z);
}

export function resetBounds(bounds: Bounds3D): void {
  bounds.min.x = Infinity;
  bounds.min.y = Infinity;
  bounds.min.z = Infinity;
  bounds.max.x = -Infinity;
  bounds.max.y = -Infinity;
  bounds.max.z = -Infinity;
}

/**
 * Mesh bounds in the renderer's shared frame, expressed in the source-bound
 * convention retained beside an anchor's immutable RTC metadata.
 */
export function sourceBoundsFromShifted(
  bounds: Bounds3D,
  originShift: Readonly<{ x: number; y: number; z: number }>,
): Bounds3D {
  return {
    min: {
      x: bounds.min.x + originShift.x,
      y: bounds.min.y + originShift.y,
      z: bounds.min.z + originShift.z,
    },
    max: {
      x: bounds.max.x + originShift.x,
      y: bounds.max.y + originShift.y,
      z: bounds.max.z + originShift.z,
    },
  };
}
