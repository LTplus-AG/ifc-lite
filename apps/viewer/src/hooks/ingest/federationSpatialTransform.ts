/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { localViewerToProjected, projectedToLocalViewer, resolveSpatialPlacement,
  type CoordinateInfo, type ModelSpatialReference } from '@ifc-lite/geometry';
import proj4 from 'proj4';
import { totalYupOffset } from '../../lib/geo/coordinate-frame.js';
import { resolveProjectionId } from '../../lib/geo/reproject.js';
import type { AffineTransform3D } from './federationAlignAabb.js';
import { projectedUnitToMetres } from './projected-units.js';

export interface PlacementInput { spatialReference: ModelSpatialReference; coordinateInfo?: CoordinateInfo }

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
    && Math.abs(transform.m20) < eps && Math.abs(transform.m21) < eps && Math.abs(transform.m22 - 1) < eps && Math.abs(transform.tz) < eps;
}

/** Build the one point map used by cross-CRS meshes, bounds and analytic curves. */
export async function buildCrossCrsPointMap(source: PlacementInput, reference: PlacementInput): Promise<{
  map: (x: number, y: number, z: number) => [number, number, number] | null;
  firstError: () => unknown;
} | null> {
  const sourceCrs = source.spatialReference.horizontal?.id;
  const referenceCrs = reference.spatialReference.horizontal?.id;
  if (!sourceCrs || !referenceCrs) return null;
  // Browser proj4 supplies no vertical operation. An absent or different datum
  // cannot be carried through as if it were the same height system.
  if (!source.spatialReference.vertical || !reference.spatialReference.vertical
    || source.spatialReference.vertical.id !== reference.spatialReference.vertical.id) return null;
  const sourceProjDef = await resolveProjectionId(sourceCrs);
  const referenceProjDef = await resolveProjectionId(referenceCrs);
  if (!sourceProjDef || !referenceProjDef) return null;
  const sourceUnit = projectedUnitToMetres(sourceProjDef);
  const referenceUnit = projectedUnitToMetres(referenceProjDef);
  if (!sourceUnit || !referenceUnit) return null;
  const sourceOffset = totalYupOffset(source.coordinateInfo);
  const referenceOffset = totalYupOffset(reference.coordinateInfo);
  let firstError: unknown = null;
  return {
    firstError: () => firstError,
    map: (x, y, z) => {
      const projectedSource = localViewerToProjected(source.spatialReference, [x, y, z], sourceOffset);
      if (!projectedSource) return null;
      const [eS, nS, hS] = projectedSource;
      let eR: number;
      let nR: number;
      try {
        const projected = proj4(sourceProjDef, referenceProjDef, [eS / sourceUnit, nS / sourceUnit]);
        eR = projected[0] * referenceUnit;
        nR = projected[1] * referenceUnit;
      } catch (error) {
        if (firstError == null) firstError = error;
        return null;
      }
      if (!Number.isFinite(eR) || !Number.isFinite(nR)) return null;
      const target = projectedToLocalViewer(reference.spatialReference, [eR, nR, hS], referenceOffset);
      return target ? [target[0], target[1], target[2]] : null;
    },
  };
}
