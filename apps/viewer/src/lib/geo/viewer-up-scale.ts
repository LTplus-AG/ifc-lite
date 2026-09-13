/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scale x FactorZ in the Cesium viewer frame, which draws viewer Y at
 * `placementHeight + viewerUpScale * (y - modelCenterY)` (cesium-bridge.ts):
 * the placement gizmo's height conversions and the camera hold (#4675).
 */

import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

import { effectiveMapConversionForGeometry } from './map-absolute';
import { getEffectiveAxisScales, resolveMapUnitToMetreScale } from './geo-scale';

/** The frame's gizmo height arguments: the conversion, CRS, length unit, geometry. */
type HeightFrame = [
  mapConversion: MapConversion,
  projectedCRS: Pick<ProjectedCRS, 'mapUnitScale'> | undefined,
  lengthUnitScale: number,
  coordinateInfo: CoordinateInfo | undefined,
];

const usableScale = (scale: number) => Number.isFinite(scale) && Math.abs(scale) >= 1e-12;

/** Divide by an axis scale, 0 for a zero or non-finite one, so a flat axis cannot put the gizmo at infinity. */
export function divideByAxisScale(value: number, scale: number): number {
  return usableScale(scale) ? value / scale : 0;
}

/** The vertical part of a viewer frame: height = placementHeight + viewerUpScale * (y - modelCenterY). */
export interface ViewerHeightFrame { placementHeight: number; viewerUpScale: number; modelCenterY: number }

/**
 * The viewer Y that keeps the camera at the same world height when the frame
 * is rebuilt from `before` to `after` (an OrthogonalHeight or Scale edit, or
 * new bounds). Height only. `y` itself when either frame is flat.
 */
export function holdCameraY(y: number, before: ViewerHeightFrame, after: ViewerHeightFrame): number {
  if (!usableScale(before.viewerUpScale) || !usableScale(after.viewerUpScale)) return y;
  const worldHeight = before.placementHeight + before.viewerUpScale * (y - before.modelCenterY);
  return after.modelCenterY + (worldHeight - after.placementHeight) / after.viewerUpScale;
}

const mapUnitScale = (frame: HeightFrame) => resolveMapUnitToMetreScale(frame[1]?.mapUnitScale, frame[2]);

/**
 * Metres of height per viewer Y unit (Scale x FactorZ), through the
 * map-absolute guard (#2526), as the Cesium bridge derives `viewerUpScale`.
 */
export function viewerUpScaleForGeometry(...frame: HeightFrame): number {
  const [conversion, , lengthUnitScale, coordinateInfo] = frame;
  const mapScale = mapUnitScale(frame);
  const guarded = effectiveMapConversionForGeometry(conversion, mapScale, coordinateInfo);
  return getEffectiveAxisScales(guarded, mapScale, lengthUnitScale).z;
}

/** The gizmo's height drag: a viewer-Y delta as an OrthogonalHeight delta in map units. */
export function viewerHeightDeltaToOrthogonalHeightDeltaForGeometry(deltaY: number, ...frame: HeightFrame): number {
  return (deltaY * viewerUpScaleForGeometry(...frame)) / mapUnitScale(frame);
}

/** The gizmo's height preview: the inverse of the drag conversion above. */
export function orthogonalHeightDeltaToViewerDeltaForGeometry(deltaHeight: number, ...frame: HeightFrame): number {
  return divideByAxisScale(deltaHeight * mapUnitScale(frame), viewerUpScaleForGeometry(...frame));
}
