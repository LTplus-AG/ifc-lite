/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IfcSite RefLatitude/RefLongitude derived from the map conversion: the site
 * placement's origin taken through the conversion into map coordinates, then
 * through the reprojector to WGS84.
 *
 * Derived only from a map conversion the checker found plausible: no
 * error-level finding, the area-of-use check ran and passed, not at the
 * CRS's false origin or 0°/0°, and an unambiguous map unit. A datum shift
 * done by a Helmert approximation (or not at all, its grid missing) is
 * flagged `approximateDatum`, which only the caller can accept.
 * RefElevation is derived only when the CRS states a VerticalDatum.
 */

import type { CrsCatalog, CrsRequirement, GeorefFacts, GeorefReport, OperationFact, CrsFact } from '@ifc-lite/georef-check';
import type { CrsTransformer } from '@ifc-lite/geo';
import type { GeorefSiteDerivation } from './types.js';

/** A map position this close to E 0 / N 0 is the CRS's false origin (georef-check's FALSE_ORIGIN_RADIUS_METRES). */
const FALSE_ORIGIN_METRES = 1_000;
/** 0°/0° written with rounding noise (georef-check's NULL_ISLAND_TOLERANCE_DEGREES). */
const NULL_ISLAND_DEGREES = 0.001;
/** About 1 cm: finer than any site reference point needs. */
const DEGREE_DIGITS = 7;

function effectiveSource(facts: GeorefFacts, report: GeorefReport): { op?: OperationFact; crs?: CrsFact } {
  if (report.effectiveSource === 'ePSet_MapConversion') return { op: facts.ePSet?.operation, crs: facts.ePSet?.crs };
  if (report.effectiveSource === 'IfcMapConversion' || report.effectiveSource === 'IfcRigidOperation') {
    return { op: facts.entities?.operation, crs: facts.entities?.crs };
  }
  return {};
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

export function deriveSitePosition(
  facts: GeorefFacts,
  report: GeorefReport,
  requirement: CrsRequirement | undefined,
  transformers: ReadonlyMap<number, CrsTransformer>,
  catalog: CrsCatalog,
): GeorefSiteDerivation {
  const blockedBy: GeorefSiteDerivation['blockedBy'] = [];
  const { op, crs } = effectiveSource(facts, report);
  if (!op || op.source === 'IfcRigidOperation') {
    return { blockedBy: [{ reason: 'unavailable', detail: 'The model has no map conversion to derive the site position from.' }] };
  }
  const transformer = requirement ? transformers.get(requirement.epsg) : undefined;
  if (!requirement || !transformer) {
    return { blockedBy: [{ reason: 'unavailable', detail: requirement ? `EPSG:${requirement.epsg} could not be resolved for reprojection.` : 'The CRS does not resolve to an EPSG code.' }] };
  }
  const errors = report.findings.filter((f) => f.severity === 'error').map((f) => f.code);
  if (errors.length > 0) blockedBy.push({ reason: 'implausible', detail: `The checker reports errors on the georeferencing (${errors.join(', ')}).` });
  if (report.skipped.some((s) => s.code === 'OUTSIDE_CRS_AREA')) {
    blockedBy.push({ reason: 'implausible', detail: `It could not be checked that the map position is inside the area of use of EPSG:${requirement.epsg}.` });
  }
  if (report.findings.some((f) => f.code === 'MAP_UNIT_MISSING' && f.severity !== 'info')) {
    blockedBy.push({ reason: 'implausible', detail: 'MapUnit is unset and readers disagree on the map unit.' });
  }

  const lengthScale = facts.lengthUnitScale > 0 ? facts.lengthUnitScale : 1;
  const mapUnit = crs?.mapUnitScale ?? catalog.lookup(requirement.epsg)?.unitScale ?? lengthScale;
  const a0 = op.xAxisAbscissa ?? 1;
  const b0 = op.xAxisOrdinate ?? 0;
  const length = Math.hypot(a0, b0) || 1;
  const [a, b] = [a0 / length, b0 / length];
  const scale = op.scale ?? 1;
  const [sx, sy, sz] = [scale * (op.factorX ?? 1), scale * (op.factorY ?? 1), scale * (op.factorZ ?? 1)];
  const site = facts.coordinates?.siteOrigin ?? (facts.coordinates?.sitePlacementId === undefined ? { x: 0, y: 0, z: 0 } : undefined);
  if (!site) return { epsg: requirement.epsg, blockedBy: [...blockedBy, { reason: 'unavailable', detail: 'The IfcSite placement cannot be read, so its position is unknown.' }] };
  // IfcMapConversion: local (project units) → map units, then metres.
  const east = (op.eastings + (sx * a * site.x - sy * b * site.y)) * mapUnit;
  const north = (op.northings + (sx * b * site.x + sy * a * site.y)) * mapUnit;
  // The site's map position, not the conversion's offsets: a zero-offset
  // conversion over absolute placements is a correct georeference.
  if (Math.abs(east) < FALSE_ORIGIN_METRES && Math.abs(north) < FALSE_ORIGIN_METRES) {
    blockedBy.push({ reason: 'implausible', detail: "The map conversion puts the site at the CRS's false origin (E 0 / N 0)." });
  }
  const lonLat = transformer.toWgs84([east, north]);
  if (!lonLat) {
    return { epsg: requirement.epsg, blockedBy: [...blockedBy, { reason: 'unavailable', detail: `EPSG:${requirement.epsg} cannot place E ${round(east, 0)} / N ${round(north, 0)} m.` }] };
  }
  const [longitude, latitude] = [round(lonLat[0], DEGREE_DIGITS), round(lonLat[1], DEGREE_DIGITS)];
  if (Math.abs(latitude) < NULL_ISLAND_DEGREES && Math.abs(longitude) < NULL_ISLAND_DEGREES) {
    blockedBy.push({ reason: 'implausible', detail: 'The map conversion places the site at 0°/0°.' });
  }
  if (transformer.datumShift !== 'as-defined') {
    blockedBy.push({
      reason: 'approximateDatum',
      detail: transformer.datumShift === 'helmert-approximation'
        ? `EPSG:${requirement.epsg} reaches WGS84 by a Helmert approximation (no datum grid loaded): the position can be off by a few metres.`
        : `EPSG:${requirement.epsg} reaches WGS84 with no datum shift (its grid is unavailable): the position can be tens to hundreds of metres off.`,
    });
  }
  const derivation: GeorefSiteDerivation = { latitude, longitude, epsg: requirement.epsg, datumShift: transformer.datumShift, blockedBy };
  if (crs?.verticalDatum?.trim()) {
    derivation.elevation = round(((op.orthogonalHeight + sz * site.z) * mapUnit) / lengthScale, 6);
  }
  return derivation;
}

/** Whether a derivation may be used, given whether the caller accepted an approximate datum shift. */
export function derivationUsable(derivation: GeorefSiteDerivation, acceptApproximateDatum: boolean): boolean {
  return derivation.latitude !== undefined
    && derivation.blockedBy.every((b) => b.reason === 'approximateDatum' && acceptApproximateDatum);
}
