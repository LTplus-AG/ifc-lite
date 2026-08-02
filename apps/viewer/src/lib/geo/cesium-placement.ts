/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

import { findClampAnchorY } from './clamp-anchor';
import { computeModelCenterInIfcMeters } from './reproject';
import { getEffectiveHorizontalScale, resolveMapUnitToMetreScale } from './geo-scale';

export function getMapUnitScale(
  projectedCRS: Pick<ProjectedCRS, 'mapUnitScale'> | undefined,
  lengthUnitScale: number,
): number {
  return resolveMapUnitToMetreScale(projectedCRS?.mapUnitScale, lengthUnitScale);
}

export function mapUnitsToMeters(
  value: number,
  projectedCRS: Pick<ProjectedCRS, 'mapUnitScale'> | undefined,
  lengthUnitScale: number,
): number {
  return value * getMapUnitScale(projectedCRS, lengthUnitScale);
}

export function metersToMapUnits(
  value: number,
  projectedCRS: Pick<ProjectedCRS, 'mapUnitScale'> | undefined,
  lengthUnitScale: number,
): number {
  return value / getMapUnitScale(projectedCRS, lengthUnitScale);
}

/**
 * Whether to REORDER terrain sampling to prefer an orthometric source
 * (Open-Meteo's bare-earth DEM) over the visible-surface / ellipsoidal ones.
 *
 * This is purely a terrain-sampling heuristic: a declared vertical datum is a
 * strong "this site cares about heights above sea level" signal, so we fetch
 * the orthometric DEM first. It does NOT decide whether the MODEL height gets
 * the geoid correction — that is `shouldApplyGeoidUndulation`, which defaults
 * on for every georeferenced model. (#1355 decoupled the two.)
 */
export function shouldPreferOrthometricTerrain(
  projectedCRS: Pick<ProjectedCRS, 'verticalDatum'> | undefined,
): boolean {
  const verticalDatum = projectedCRS?.verticalDatum?.trim();
  return Boolean(verticalDatum && verticalDatum !== '$');
}

/**
 * Whether to convert the authored (orthometric) IFC altitude into the
 * ellipsoidal height Cesium expects by adding the EGM96 geoid undulation N.
 *
 * `IfcMapConversion.OrthogonalHeight` is orthometric by spec (a height above
 * the vertical datum / mean sea level), while Cesium positions geometry by
 * ellipsoidal height (above the WGS84 ellipsoid). The two differ by N
 * (~+43..49 m in central Europe), so a georeferenced model that skips the
 * correction sinks ~N below the world terrain (#1355).
 *
 * The correction is therefore the DEFAULT for any georeferenced model. It is
 * NOT gated on a declared `IfcProjectedCRS.VerticalDatum`: that attribute is
 * optional in IFC4 / IFC4X3 and routinely omitted by exporters (very common
 * for Dutch RD-New / NAP files), yet the authored altitude is orthometric
 * regardless. The only opt-out is a file whose OrthogonalHeight is already
 * ellipsoidal, which the user signals via `heightsAreEllipsoidal`.
 */
export function shouldApplyGeoidUndulation(
  heightsAreEllipsoidal: boolean | undefined,
): boolean {
  return !heightsAreEllipsoidal;
}

export interface CesiumPlacementInput {
  coordinateInfo?: CoordinateInfo;
  projectedCRS?: Pick<ProjectedCRS, 'verticalDatum'> | Pick<ProjectedCRS, 'mapUnitScale' | 'verticalDatum'>;
  ifcOriginHeight: number;
  terrainHeight: number | null;
  storeyElevations?: Map<number, number>;
}

export interface CesiumPlacementResult {
  clampAnchorY: number;
  minY: number;
  modelCenterY: number;
  anchorOffset: number;
  ifcOriginHeight: number;
  placementHeight: number;
  terrainClipY: number | null;
  preferOrthometricTerrain: boolean;
}

/**
 * Resolve where the model sits in Cesium.
 *
 * Placement is PURELY the IFC's authored altitude — `ifcOriginHeight`
 * (IfcMapConversion.OrthogonalHeight + the geometry origin). There is NO
 * automatic terrain or storey clamp: the model goes exactly where the file
 * says, full stop. Terrain is queried only to inform the camera and the
 * optional below-terrain clip plane; it never moves the model.
 *
 * `clampAnchorY` / `anchorOffset` are still derived (the placement gizmo and
 * the clip-plane math consume them) but they no longer feed `placementHeight`.
 */
export function computeCesiumPlacement({
  coordinateInfo,
  projectedCRS,
  ifcOriginHeight,
  terrainHeight,
  storeyElevations,
}: CesiumPlacementInput): CesiumPlacementResult {
  const bounds = coordinateInfo?.originalBounds;
  const modelCenterY = bounds ? (bounds.min.y + bounds.max.y) / 2 : 0;
  const minY = bounds?.min.y ?? 0;
  const clampAnchorY = findClampAnchorY(bounds, storeyElevations);
  const anchorOffset = modelCenterY - clampAnchorY;
  // Model placement = authored IFC altitude. No clamp. No auto-adjust.
  const placementHeight = ifcOriginHeight;

  return {
    clampAnchorY,
    minY,
    modelCenterY,
    anchorOffset,
    ifcOriginHeight,
    placementHeight,
    terrainClipY: terrainHeight !== null
      ? terrainHeight - placementHeight + modelCenterY
      : null,
    preferOrthometricTerrain: shouldPreferOrthometricTerrain(projectedCRS),
  };
}

export interface OrthogonalHeightForBaseAltitudeInput {
  coordinateInfo?: CoordinateInfo;
  projectedCRS?: Pick<ProjectedCRS, 'mapUnitScale'>;
  lengthUnitScale: number;
  storeyElevations?: Map<number, number>;
  targetBaseAltitude: number;
}

export function computeOrthogonalHeightForBaseAltitude({
  coordinateInfo,
  projectedCRS,
  lengthUnitScale,
  storeyElevations,
  targetBaseAltitude,
}: OrthogonalHeightForBaseAltitudeInput): number {
  const bounds = coordinateInfo?.originalBounds;
  const anchorY = findClampAnchorY(bounds, storeyElevations);
  const shiftY = coordinateInfo?.originShift?.y ?? 0;
  // RTC offset is stored in IFC Z-up; viewer-Y aligns to its Z component.
  const rtcYupY = coordinateInfo?.wasmRtcOffset?.z ?? 0;
  const orthogonalHeightMeters = targetBaseAltitude - shiftY - rtcYupY - anchorY;

  return Math.round(
    metersToMapUnits(orthogonalHeightMeters, projectedCRS, lengthUnitScale) * 100,
  ) / 100;
}

/**
 * OrthogonalHeight-frame target for a sampled WORLD terrain altitude.
 *
 * The read path places the model base at `OrthogonalHeight + geoid undulation N`
 * (#1355), so to snap the base onto terrain whose ellipsoidal height is
 * `ellipsoidalTerrainHeight`, persist `ellipsoidalTerrainHeight - N`. With the
 * geoid correction off (heights already ellipsoidal) N is 0 and this is the
 * identity. Pass the result as `targetBaseAltitude` to
 * {@link computeOrthogonalHeightForBaseAltitude}. (#1456)
 */
export function orthometricTargetForTerrain(
  ellipsoidalTerrainHeight: number,
  geoidUndulation: number,
): number {
  return ellipsoidalTerrainHeight - geoidUndulation;
}

export function computeIfcOriginHeight(
  mapConversion: Pick<MapConversion, 'orthogonalHeight'>,
  projectedCRS: Pick<ProjectedCRS, 'mapUnitScale'> | undefined,
  coordinateInfo: CoordinateInfo | undefined,
  lengthUnitScale: number,
): number {
  const mapScale = getMapUnitScale(projectedCRS, lengthUnitScale);
  return mapConversion.orthogonalHeight * mapScale + computeModelCenterInIfcMeters(coordinateInfo).ifcZ;
}

export function viewerDeltaToProjectedDelta(
  deltaX: number,
  deltaZ: number,
  mapConversion: Pick<MapConversion, 'xAxisAbscissa' | 'xAxisOrdinate' | 'scale'>,
  projectedCRS: Pick<ProjectedCRS, 'mapUnitScale'> | undefined,
  lengthUnitScale: number,
): { eastings: number; northings: number } {
  const mapScale = getMapUnitScale(projectedCRS, lengthUnitScale);
  const hScale = getEffectiveHorizontalScale(
    mapConversion.scale,
    mapScale,
    lengthUnitScale,
  );
  const abscissa = mapConversion.xAxisAbscissa ?? 1;
  const ordinate = mapConversion.xAxisOrdinate ?? 0;
  const eastMeters = hScale * (abscissa * deltaX + ordinate * deltaZ);
  const northMeters = hScale * (ordinate * deltaX - abscissa * deltaZ);

  return {
    eastings: metersToMapUnits(eastMeters, projectedCRS, lengthUnitScale),
    northings: metersToMapUnits(northMeters, projectedCRS, lengthUnitScale),
  };
}

export interface Ray3 {
  origin: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
}

/**
 * Intersect a ray with the horizontal plane y = planeY. Returns null when the
 * ray is (near-)parallel to the plane or the hit lies behind the ray origin.
 *
 * Used by the placement gizmo's XY drag: a stable horizontal drag plane
 * through the gizmo anchor avoids the projection-Jacobian instability of
 * linearised screen-axis approximations, which blow up to "huge jumps" at
 * oblique camera angles when the gizmo plane is near-edge-on to the camera.
 */
export function intersectRayWithHorizontalPlane(
  ray: Ray3,
  planeY: number,
): { x: number; y: number; z: number } | null {
  const dirY = ray.direction.y;
  if (!Number.isFinite(dirY) || Math.abs(dirY) < 1e-6) return null;
  const t = (planeY - ray.origin.y) / dirY;
  if (!Number.isFinite(t) || t < 0) return null;
  return {
    x: ray.origin.x + ray.direction.x * t,
    y: planeY,
    z: ray.origin.z + ray.direction.z * t,
  };
}

/**
 * Find the Y-coordinate on the vertical line (anchorX, *, anchorZ) closest
 * to a ray. Returns null when the ray's horizontal component vanishes (the
 * ray is parallel to the vertical line — no meaningful "grab" point).
 *
 * Used by the placement gizmo's height drag so the slider tracks the cursor
 * accurately at any camera tilt, instead of linearising screen-space pixels
 * per metre.
 */
export function closestYOnVerticalLineFromRay(
  ray: Ray3,
  anchorX: number,
  anchorZ: number,
): number | null {
  const dx = ray.direction.x;
  const dz = ray.direction.z;
  const horiz = dx * dx + dz * dz;
  if (!Number.isFinite(horiz) || horiz < 1e-12) return null;
  const s = (dx * (anchorX - ray.origin.x) + dz * (anchorZ - ray.origin.z)) / horiz;
  return ray.origin.y + s * ray.direction.y;
}

export function projectedDeltaToViewerDelta(
  eastingsDelta: number,
  northingsDelta: number,
  mapConversion: Pick<MapConversion, 'xAxisAbscissa' | 'xAxisOrdinate' | 'scale'>,
  projectedCRS: Pick<ProjectedCRS, 'mapUnitScale'> | undefined,
  lengthUnitScale: number,
): { x: number; z: number } {
  const mapScale = getMapUnitScale(projectedCRS, lengthUnitScale);
  const hScale = getEffectiveHorizontalScale(
    mapConversion.scale,
    mapScale,
    lengthUnitScale,
  );
  const abscissa = mapConversion.xAxisAbscissa ?? 1;
  const ordinate = mapConversion.xAxisOrdinate ?? 0;
  const eastMeters = mapUnitsToMeters(eastingsDelta, projectedCRS, lengthUnitScale);
  const northMeters = mapUnitsToMeters(northingsDelta, projectedCRS, lengthUnitScale);
  const denom = Math.max((abscissa * abscissa + ordinate * ordinate) * hScale, 1e-12);

  return {
    x: (abscissa * eastMeters + ordinate * northMeters) / denom,
    z: (ordinate * eastMeters - abscissa * northMeters) / denom,
  };
}
