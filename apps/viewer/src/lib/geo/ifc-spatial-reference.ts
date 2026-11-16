/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** IFC's parser-shaped georeference adapted to the format-neutral geometry contract. */

import type { CoordinateInfo, ModelSpatialReference } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { wellKnownCrsCode } from '@ifc-lite/geo';
import { getEffectiveAxisScales, resolveMapUnitToMetreScale } from './geo-scale.js';
import { effectiveMapConversionForGeometry } from './map-absolute.js';

export interface IfcSpatialReferenceInput {
  mapConversion: MapConversion;
  projectedCRS: ProjectedCRS;
  lengthUnitScale: number;
  coordinateInfo?: CoordinateInfo;
}

/**
 * A canonical CRS identifier for IFC's declared Name: a literal `EPSG:nnnn`,
 * or one of the explicit authoring-tool aliases `@ifc-lite/geo` lists
 * ("CH1903+ / LV95", "LV95", "Amersfoort / RD New", ...). Only exact
 * listed names count, never a coordinate magnitude or a fuzzy match, and an
 * alias resolves as `assumed` so the UI can say the CRS was taken from its
 * name. Other display names remain source metadata.
 */
export function declaredEpsg(name: string | undefined): { id: string; fromName: boolean } | undefined {
  const trimmed = name?.trim() ?? '';
  const match = /^EPSG\s*:\s*(\d+)$/i.exec(trimmed);
  if (match) return { id: `EPSG:${match[1]}`, fromName: false };
  const alias = trimmed ? wellKnownCrsCode(trimmed) : undefined;
  // A datum-only geographic label ("WGS 84", "ETRS89") names no projection:
  // as an IfcProjectedCRS it would turn metre offsets into degrees.
  return alias && !GEOGRAPHIC_ALIAS_CODES.has(alias) ? { id: `EPSG:${alias}`, fromName: true } : undefined;
}

const GEOGRAPHIC_ALIAS_CODES = new Set(['4326', '4269', '4267', '4258']);

/** The EPSG id a CRS Name was assumed to mean, when it is a listed alias rather than a literal `EPSG:nnnn`. */
export function crsAssumedFromName(name: string | undefined): string | undefined {
  const declared = declaredEpsg(name);
  return declared?.fromName ? declared.id : undefined;
}

/** Exact, authoritative vertical-datum names commonly written by IFC tools, keyed upper-case. */
const VERTICAL_DATUM_ALIASES: Record<string, string> = {
  'NAVD88': 'EPSG:5703', 'NORTH AMERICAN VERTICAL DATUM 1988': 'EPSG:5703',
  'NAP': 'EPSG:5709', 'NORMAAL AMSTERDAMS PEIL': 'EPSG:5709',
  // Switzerland: LN02 (levelling network 1902, what swissALTI3D and the
  // cadastral survey use) and LHN95 (the 1995 orthometric height network).
  // Not interchangeable: they differ by decimetres and more in the Alps.
  'LN02': 'EPSG:5728', 'LN 02': 'EPSG:5728', 'LN02 HEIGHT': 'EPSG:5728', 'LANDESNIVELLEMENT 1902': 'EPSG:5728',
  'LHN95': 'EPSG:5729', 'LHN 95': 'EPSG:5729', 'LHN95 HEIGHT': 'EPSG:5729',
  'LANDESHOEHENNETZ 1995': 'EPSG:5729', 'LANDESHÖHENNETZ 1995': 'EPSG:5729',
};

function declaredVerticalEpsg(name: string | undefined): string | undefined {
  const match = /^EPSG\s*:\s*(\d+)$/i.exec(name?.trim() ?? '');
  if (match) return `EPSG:${match[1]}`;
  return VERTICAL_DATUM_ALIASES[name?.trim().toUpperCase() ?? ''];
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
  const verticalEpsg = declaredVerticalEpsg(input.projectedCRS.verticalDatum);
  return Object.freeze({
    source: Object.freeze({
      axes: ['east', 'up', 'south'],
      horizontalUnitToMetres: 1,
      verticalUnitToMetres: 1,
    } as const),
    ...(epsg ? { horizontal: Object.freeze({ id: epsg.id, provenance: Object.freeze({ source: epsg.fromName ? 'IfcProjectedCRS.Name (well-known name)' : 'IfcProjectedCRS.Name' }) }) } : {}),
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
    confidence: epsg ? (epsg.fromName ? 'assumed' : 'declared') : 'unknown',
    sourceMetadata: Object.freeze({
      format: 'ifc',
      mapConversionExpressId: input.mapConversion.id,
      projectedCrsExpressId: input.projectedCRS.id,
      mapUnitToMetres: mapUnitScale,
      ...(input.projectedCRS.mapUnit ? { mapUnit: input.projectedCRS.mapUnit } : {}),
      ...(input.projectedCRS.name ? { projectedCrsName: input.projectedCRS.name } : {}),
      ...(input.projectedCRS.verticalDatum ? { verticalDatum: input.projectedCRS.verticalDatum } : {}),
    }),
  });
}

/**
 * True when the reference's IfcProjectedCRS.MapUnit reads as METRE at scale 1.
 * `@ifc-lite/parser` gives an unresolvable MapUnit exactly that answer, so a
 * declared metre and an unreadable unit cannot be told apart: callers say the
 * map unit is assumed to be metres.
 */
export function mapUnitAssumedMetres(reference: ModelSpatialReference): boolean {
  const meta = reference.sourceMetadata;
  return meta?.format === 'ifc' && meta.mapUnit === 'METRE' && meta.mapUnitToMetres === 1;
}
