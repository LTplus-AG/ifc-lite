/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Resolve the scale factor converting `IfcMapConversion.eastings/northings/
 * orthogonalHeight` into metres (the unit proj4 expects).
 *
 * IFC4 spec: those offsets are in `IfcProjectedCRS.MapUnit`, falling back to
 * the project's `IfcUnitAssignment` LengthUnit when MapUnit is absent.
 *
 * Real-world practice diverges: Bonsai, IfcOpenShell, and most surveying
 * pipelines emit metre values regardless of the project's length unit because
 * survey CRS offsets come in metres. When MapUnit is absent AND the project
 * unit isn't metres, applying the spec interpretation pushes coords miles
 * outside the CRS's valid range, and projections like RD New / OSGB / Lambert
 * extrapolate to the projection's antipode (e.g. an RD easting of `126500`
 * read as mm = `126.5 m` → South Pacific instead of the Netherlands).
 *
 * Heuristic: when no explicit MapUnit is set, treat the offsets as metres.
 * Files that genuinely use non-metre offsets can set MapUnit explicitly
 * (e.g. `IfcProjectedCRS.MapUnit = MILLIMETRE`) to opt out.
 */
export function resolveMapUnitToMetreScale(
  mapUnitScaleFromCrs: number | undefined,
  lengthUnitScale: number,
): number {
  if (mapUnitScaleFromCrs && mapUnitScaleFromCrs > 0) return mapUnitScaleFromCrs;
  void lengthUnitScale; // parameter kept for future spec-strict override
  return 1;
}
