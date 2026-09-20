/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Compute the viewer-space position of a model's IFC (0,0,0) point.
 *
 * This is an overlay consumer of the format-neutral spatial-reference
 * contract. It deliberately owns no IFC-shaped georeference record or map
 * conversion arithmetic: source adapters construct a ModelSpatialReference,
 * then every conversion below goes through the shared geometry primitives.
 */

import proj4 from 'proj4';
import {
  localViewerToProjected,
  projectedToLocalViewer,
  type CoordinateInfo,
  type ModelSpatialReference,
} from '@ifc-lite/geometry';
import { totalYupOffset } from './coordinate-frame';
import { resolveProjectionId } from './reproject';

export interface IfcOriginPlacement {
  /** Viewer-local position (Y-up) where this model's IFC (0,0,0) currently sits. */
  viewer: { x: number; y: number; z: number };
  /** `anchor` means the neutral placement was resolved into the anchor frame. */
  source: 'self' | 'anchor' | 'fallback';
}

/**
 * The minimum frame record needed by an origin overlay. `spatialReference` is
 * optional so a non-georeferenced model can still show its own local origin;
 * when an anchor is supplied, an incomplete or incompatible reference refuses
 * a derived origin rather than guessing a position.
 */
export interface IfcOriginFrame {
  readonly coordinateInfo?: CoordinateInfo;
  readonly spatialReference?: ModelSpatialReference;
  readonly preAlignmentCoordinateInfo?: CoordinateInfo;
}

function ownOrigin(coordinateInfo?: CoordinateInfo): IfcOriginPlacement {
  const offset = totalYupOffset(coordinateInfo);
  return { viewer: { x: -offset.x, y: -offset.y, z: -offset.z }, source: 'self' };
}

function verticalCompatible(source: ModelSpatialReference, target: ModelSpatialReference): boolean {
  // A browser proj4 hop has no vertical-datum operation. Do not publish an
  // origin whose horizontal coordinates look right while its elevation means
  // something different (or unknown) in the anchor frame.
  return source.vertical !== undefined
    && target.vertical !== undefined
    && source.vertical.id === target.vertical.id;
}

/**
 * Resolve an IFC origin into the anchor viewer frame. Same-CRS and cross-CRS
 * paths share `localViewerToProjected` / `projectedToLocalViewer`; only the
 * explicit horizontal projection operation differs. Unknown, mismatched, or
 * unsupported vertical frames fail closed.
 */
export async function computeIfcOriginViewerPosition(
  model: IfcOriginFrame,
  anchor?: IfcOriginFrame | null,
): Promise<IfcOriginPlacement | null> {
  if (!anchor || model === anchor || !model.spatialReference) return ownOrigin(model.coordinateInfo);
  if (!anchor.spatialReference) {
    const offset = totalYupOffset(model.preAlignmentCoordinateInfo ?? model.coordinateInfo);
    return { viewer: { x: -offset.x, y: -offset.y, z: -offset.z }, source: 'fallback' };
  }

  const source = model.spatialReference;
  const target = anchor.spatialReference;
  const sourceCrs = source.horizontal?.id;
  const targetCrs = target.horizontal?.id;
  if (!sourceCrs || !targetCrs || !verticalCompatible(source, target)) return null;

  // IFC local origin has no renderer/RTC offset. The anchor inverse receives
  // its render-frame offset, exactly as federation alignment does.
  const projectedSource = localViewerToProjected(source, [0, 0, 0]);
  if (!projectedSource) return null;
  let projectedTarget = projectedSource;
  if (sourceCrs !== targetCrs) {
    const [sourceDefinition, targetDefinition] = await Promise.all([
      resolveProjectionId(sourceCrs),
      resolveProjectionId(targetCrs),
    ]);
    if (!sourceDefinition || !targetDefinition) return null;
    try {
      const transformed = proj4(sourceDefinition, targetDefinition, [projectedSource[0], projectedSource[1]]);
      if (!Number.isFinite(transformed[0]) || !Number.isFinite(transformed[1])) return null;
      projectedTarget = [transformed[0], transformed[1], projectedSource[2]];
    } catch (error) {
      console.warn(`[ifc-origin] projection failed (${sourceCrs} → ${targetCrs}):`, error);
      return null;
    }
  }
  const viewer = projectedToLocalViewer(target, projectedTarget, totalYupOffset(anchor.coordinateInfo));
  return viewer ? { viewer: { x: viewer[0], y: viewer[1], z: viewer[2] }, source: 'anchor' } : null;
}
