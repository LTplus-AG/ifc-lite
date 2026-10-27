/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Grid-to-ground scale for the globe placement.
 *
 * A projected CRS's map (grid) coordinates are not ground lengths: a grid
 * distance is the ground distance times the combined scale factor
 * k_c = k · R/(R+h), where k is the projection's point scale factor (UTM:
 * 0.9996 on the central meridian) and R/(R+h) reduces a length at ellipsoidal
 * height h to the ellipsoid. Cesium places the model in a true-length ENU
 * frame, so a model whose coordinates ARE grid coordinates must be drawn at
 * 1/k_c of them, or it is 0.04 % too large on a UTM central meridian (32 mm
 * per 100 m).
 *
 * WHICH SOURCES ARE GRID COORDINATES (and get 1/k_c):
 * - `IfcRigidOperation` into a projected CRS. The operation is "an offset in
 *   the CRS … not any conversion or distortion" (IFC4.3 IfcRigidOperation),
 *   so the geometry is map coordinates.
 * - Map-absolute geometry (#2526): the geometry already sits at the map
 *   anchor, i.e. it was drawn in map coordinates.
 * - An `IfcMapConversion(Scaled)` whose effective horizontal scale IS the
 *   combined scale factor: Scale·FactorX (unit-bridged, `getEffectiveAxisScales`)
 *   within {@link GRID_FACTOR_TOLERANCE} of k_c and not 1. IFC4.3
 *   IfcMapConversionScaled gives x' = Scale·FactorX·cosθ·x − … + Eastings,
 *   with x' a MAP coordinate; IfcOpenShell's `xyz2enh` (util/geolocation.py,
 *   v0.8.0) documents FactorX as "the combined scale factor … to convert from
 *   local coordinates to map coordinates". IFC4 files without the subtype
 *   carry the same factor in Scale (the buildingSMART
 *   georeferenced-bridge-deck sample: UTM 10N, Scale 0.9996). Either way the
 *   local model is in ground lengths and the map delta in grid lengths:
 *   ground = map delta / k_c ≈ x. ifc-lite used to place the map delta itself
 *   in ENU, a grid-sized model. Any other scale (an exaggeration, a unit
 *   mismatch the #595 heuristic does not bridge) keeps its literal meaning.
 *
 * WHICH ARE NOT:
 * - `IfcMapConversion` with an effective scale of 1 (Scale = 1, or a Scale or
 *   factor that only bridges units). Its Scale exists "to convert units" and
 *   the local engineering CRS is topocentric; in practice that means the
 *   model is in true lengths. Dividing by k_c would shrink a correctly drawn
 *   model, so it stays as is. This is a product decision as much as a reading
 *   of the spec; see docs/architecture/coordinate-handling.md.
 * - A geographic target CRS: the geometry is ENU metres around the anchor.
 */

import type { MapConversion } from '@ifc-lite/parser';
import { wgs84RadiiOfCurvature } from './proj4-utils';

/**
 * How far (relative) an effective horizontal scale may sit from the computed
 * k_c and still be read as the combined scale factor. 1e-3 covers the spread a
 * project-constant factor shows across a site and between height assumptions
 * (UTM k spans 0.9996-1.001 over a zone; 600 m of height moves k_c by 1e-4),
 * while a unit bridge (0.3048, 0.001) or a deliberate exaggeration is
 * orders of magnitude further away.
 */
export const GRID_FACTOR_TOLERANCE = 1e-3;

/** Why the anchor placement treats the model as grid coordinates. */
export type GridCoordinateSource = 'rigidOperation' | 'mapAbsolute' | 'gridScale';

/** R/(R+h): reduces a length at ellipsoidal height h to the WGS84 ellipsoid (R = Gaussian mean radius). */
export function elevationFactor(latDeg: number, ellipsoidalHeight: number): number {
  const { meridian, primeVertical } = wgs84RadiiOfCurvature(latDeg);
  const r = Math.sqrt(meridian * primeVertical);
  return r / (r + ellipsoidalHeight);
}

/** Combined (grid-to-ground) scale factor k_c = k · R/(R+h): grid length = k_c · ground length. */
export function combinedScaleFactor(pointScale: number, latDeg: number, ellipsoidalHeight: number): number {
  return pointScale * elevationFactor(latDeg, ellipsoidalHeight);
}

/**
 * Classify a conversion into a projected CRS as a grid-coordinate source, or
 * null for true-length geometry. `effectiveScales` are the horizontal
 * coefficients the placement applies (`getEffectiveAxisScales`, after the
 * map-absolute neutralisation, which resets them to 1).
 */
export function gridCoordinateSource(
  conversion: Pick<MapConversion, 'operation'>,
  effectiveScales: { x: number; y: number },
  mapAbsolute: boolean,
  combinedScale: number,
): GridCoordinateSource | null {
  if (conversion.operation === 'rigidOperation') return 'rigidOperation';
  if (mapAbsolute) return 'mapAbsolute';
  const unit = (f: number) => Math.abs(f - 1) <= 1e-9;
  if (unit(effectiveScales.x) && unit(effectiveScales.y)) return null;
  const near = (f: number) => Math.abs(f / combinedScale - 1) <= GRID_FACTOR_TOLERANCE;
  return near(effectiveScales.x) && near(effectiveScales.y) ? 'gridScale' : null;
}
