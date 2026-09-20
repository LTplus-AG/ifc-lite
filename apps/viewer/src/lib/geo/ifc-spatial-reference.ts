/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** IFC's parser-shaped georeference adapted to the format-neutral geometry contract. */

import type { CoordinateInfo, ModelSpatialReference } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { getEffectiveAxisScales, resolveMapUnitToMetreScale } from './geo-scale.js';
import { effectiveMapConversionForGeometry } from './map-absolute.js';

export interface IfcSpatialReferenceInput {
  mapConversion: MapConversion;
  projectedCRS: ProjectedCRS;
  lengthUnitScale: number;
  coordinateInfo?: CoordinateInfo;
}

/**
 * Extract a canonical CRS identifier only when IFC's declared Name is itself
 * an EPSG identifier. Arbitrary display names remain source metadata: treating
 * matching labels as a CRS match was the old IFC-only federation seam.
 */
function declaredEpsg(name: string | undefined): string | undefined {
  const match = /^EPSG\s*:\s*(\d+)$/i.exec(name?.trim() ?? '');
  return match ? `EPSG:${match[1]}` : undefined;
}

/**
 * Convert current IFC metadata to an immutable format-neutral reference.
 * `effectiveMapConversionForGeometry` remains the one #2526 map-absolute
 * compatibility decision; the resulting operation has no IFC runtime types.
 */
export function spatialReferenceFromIfc(input: IfcSpatialReferenceInput): ModelSpatialReference {
  const lengthUnitScale = input.lengthUnitScale > 0 ? input.lengthUnitScale : 1;
  const mapUnitScale = resolveMapUnitToMetreScale(input.projectedCRS.mapUnitScale, lengthUnitScale);
  const conversion = effectiveMapConversionForGeometry(
    input.mapConversion,
    mapUnitScale,
    input.coordinateInfo,
  );
  const scale = getEffectiveAxisScales(conversion, mapUnitScale, lengthUnitScale);
  const epsg = declaredEpsg(input.projectedCRS.name);
  const verticalEpsg = declaredEpsg(input.projectedCRS.verticalDatum);
  return Object.freeze({
    source: Object.freeze({
      axes: ['east', 'up', 'south'],
      horizontalUnitToMetres: 1,
      verticalUnitToMetres: 1,
    } as const),
    ...(epsg ? { horizontal: Object.freeze({ id: epsg, provenance: Object.freeze({ source: 'IfcProjectedCRS.Name' }) }) } : {}),
    ...(verticalEpsg ? { vertical: Object.freeze({ id: verticalEpsg, provenance: Object.freeze({ source: 'IfcProjectedCRS.VerticalDatum' }) }) } : {}),
    localToProjected: Object.freeze({
      kind: 'local-projected-affine',
      eastings: conversion.eastings * mapUnitScale,
      northings: conversion.northings * mapUnitScale,
      orthogonalHeight: conversion.orthogonalHeight * mapUnitScale,
      xAxisAbscissa: conversion.xAxisAbscissa ?? 1,
      xAxisOrdinate: conversion.xAxisOrdinate ?? 0,
      scaleX: scale.x,
      scaleY: scale.y,
      scaleZ: scale.z,
    } as const),
    confidence: epsg ? 'declared' : 'unknown',
    sourceMetadata: Object.freeze({
      format: 'ifc',
      mapConversionExpressId: input.mapConversion.id,
      projectedCrsExpressId: input.projectedCRS.id,
      ...(input.projectedCRS.name ? { projectedCrsName: input.projectedCRS.name } : {}),
      ...(input.projectedCRS.verticalDatum ? { verticalDatum: input.projectedCRS.verticalDatum } : {}),
    }),
  });
}
