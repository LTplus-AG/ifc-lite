/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

import { findClampAnchorY } from './clamp-anchor';
import { computeModelCenterInIfcMeters } from './reproject';
import { getEffectiveHorizontalScale } from './geo-scale';

export function getMapUnitScale(
  projectedCRS: Pick<ProjectedCRS, 'mapUnitScale'> | undefined,
  lengthUnitScale: number,
): number {
  const mapUnitScale = projectedCRS?.mapUnitScale;
  if (typeof mapUnitScale === 'number' && mapUnitScale > 0) return mapUnitScale;
  return lengthUnitScale > 0 ? lengthUnitScale : 1;
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

export function shouldPreferOrthometricTerrain(
  projectedCRS: Pick<ProjectedCRS, 'verticalDatum'> | undefined,
): boolean {
  const verticalDatum = projectedCRS?.verticalDatum?.trim();
  return Boolean(verticalDatum && verticalDatum !== '$');
}

export interface CesiumPlacementInput {
  coordinateInfo?: CoordinateInfo;
  projectedCRS?: Pick<ProjectedCRS, 'verticalDatum'> | Pick<ProjectedCRS, 'mapUnitScale'> & Pick<ProjectedCRS, 'verticalDatum'>;
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
  const terrainPlacementHeight = terrainHeight !== null
    ? terrainHeight + anchorOffset
    : null;
  const placementHeight = terrainPlacementHeight !== null
    ? Math.max(ifcOriginHeight, terrainPlacementHeight)
    : ifcOriginHeight;

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
