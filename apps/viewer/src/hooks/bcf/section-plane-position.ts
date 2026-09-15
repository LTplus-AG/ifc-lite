/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ViewerBounds, ViewerSectionPlane } from '@ifc-lite/bcf';

export interface CapturedSectionPlane {
  axis: ViewerSectionPlane['axis'];
  worldPosition: number;
  flipped: boolean;
}

/** Preserve an absolute rendered cut through BCF's percentage/bounds input. */
export function capturedSectionPlaneInput(
  captured: CapturedSectionPlane,
  bounds: ViewerBounds | undefined,
): { sectionPlane: ViewerSectionPlane; bounds: ViewerBounds } {
  const axis = captured.axis === 'side' ? 'x' : captured.axis === 'down' ? 'y' : 'z';
  const source = bounds ?? { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const adjusted: ViewerBounds = {
    min: {
      x: serializableMidpoint(source.min.x, source.max.x),
      y: serializableMidpoint(source.min.y, source.max.y),
      z: serializableMidpoint(source.min.z, source.max.z),
    },
    max: {
      x: serializableMidpoint(source.min.x, source.max.x),
      y: serializableMidpoint(source.min.y, source.max.y),
      z: serializableMidpoint(source.min.z, source.max.z),
    },
  };
  const range = source.max[axis] - source.min[axis];
  const position = ((captured.worldPosition - source.min[axis]) / range) * 100;
  // Match sectionPlaneToClippingPlane's operation order. A finite percentage
  // can still overflow or catastrophically cancel while reconstructing the cut.
  const reconstructed = source.min[axis] + (position / 100) * range;
  const scale = Math.max(Math.abs(source.min[axis]), Math.abs(source.max[axis]), 1);
  const relativeCutError = Math.abs(reconstructed - captured.worldPosition) /
    Math.max(Math.abs(captured.worldPosition), 1);
  if (Number.isFinite(range) && Math.abs(range) > Number.EPSILON * scale &&
      Number.isFinite(position) && Number.isFinite(reconstructed) &&
      relativeCutError <= Number.EPSILON * 8) {
    adjusted.min[axis] = source.min[axis];
    adjusted.max[axis] = source.max[axis];
    return {
      sectionPlane: { axis: captured.axis, flipped: captured.flipped, enabled: true,
        position },
      bounds: adjusted,
    };
  }
  adjusted.min[axis] = captured.worldPosition;
  adjusted.max[axis] = captured.worldPosition;
  return { sectionPlane: { axis: captured.axis, flipped: captured.flipped, enabled: true, position: 50 }, bounds: adjusted };
}

/** Produce bounds whose downstream `(min + max) / 2` stays finite. */
function serializableMidpoint(min: number, max: number): number {
  const midpoint = (min + max) / 2;
  return Number.isFinite(midpoint) && Number.isFinite(midpoint + midpoint) ? midpoint : 0;
}
