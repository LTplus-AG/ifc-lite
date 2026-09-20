/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { resolveSpatialPlacement, type CoordinateInfo, type ModelSpatialReference } from '@ifc-lite/geometry';
import { totalYupOffset } from '../../lib/geo/coordinate-frame.js';
import type { AffineTransform3D } from './federationAlignAabb.js';

interface PlacementInput { spatialReference: ModelSpatialReference; coordinateInfo?: CoordinateInfo }

export function buildSpatialAlignmentTransform(source: PlacementInput, reference: PlacementInput): AffineTransform3D | null {
  const resolved = resolveSpatialPlacement(source.spatialReference, reference.spatialReference, {
    sourceFrameOffset: totalYupOffset(source.coordinateInfo), targetFrameOffset: totalYupOffset(reference.coordinateInfo),
  });
  return resolved.ok ? resolved.placement.sourceToFederation : null;
}

export function isIdentitySpatialTransform(transform: AffineTransform3D): boolean {
  const eps = 1e-7;
  return Math.abs(transform.m00 - 1) < eps && Math.abs(transform.m01) < eps && Math.abs(transform.m02) < eps && Math.abs(transform.tx) < eps
    && Math.abs(transform.m10) < eps && Math.abs(transform.m11 - 1) < eps && Math.abs(transform.m12) < eps && Math.abs(transform.ty) < eps
    && Math.abs(transform.m20) < eps && Math.abs(transform.m21) < eps && Math.abs(transform.m22 - 1) < eps && Math.abs(transform.m12) < eps && Math.abs(transform.tz) < eps;
}
