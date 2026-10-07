/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import proj4 from 'proj4';

export function isGeographicProj4(definition: string): boolean {
  return /\+proj=longlat\b/.test(definition);
}

export function utmProj4String(zone: string): string | null {
  const match = zone.match(/^(\d{1,2})([NS])$/i);
  if (!match) return null;
  const zoneNumber = parseInt(match[1], 10);
  if (zoneNumber < 1 || zoneNumber > 60) return null;
  return `+proj=utm +zone=${zoneNumber}${match[2].toUpperCase() === 'N' ? '' : ' +south'} +datum=WGS84 +units=m +no_defs`;
}

/**
 * Geometry and spatial references carry projected distances in metres. PROJ
 * strings instead describe the CRS's native output unit (e.g. US survey ft).
 * Override that unit at the metre-coordinate boundary; projection offsets
 * +x_0/+y_0 are already metres and must remain untouched.
 * https://proj.org/en/stable/usage/projections.html#projection-units
 */
export function projectedDefinitionInMetres(definition: string): string {
  if (isGeographicProj4(definition)) return definition;
  return `${definition.replace(/(?:^|\s)\+(?:units|to_meter)=\S+/g, '').trim()} +units=m`;
}

/**
 * Grid (meridian) convergence at a point in a projected CRS: the angle between
 * grid north (the projected CRS's +N axis) and true north (the geographic ENU
 * +N axis). Returned in radians, counter-clockwise positive, such that the grid
 * frame equals the true-ENU frame rotated by +gamma.
 *
 * WHY THIS EXISTS: `IfcMapConversion` aligns the model to GRID north (its
 * XAxisAbscissa/Ordinate are expressed in the projected grid), but Cesium's
 * `eastNorthUpToFixedFrame()` builds a TRUE-north ENU frame. Feeding the
 * grid-aligned model straight into that frame rotates it by the convergence —
 * up to ~3° for UTM near a zone edge, ~7-8° for oblique projections like
 * Krovak (EPSG:2065, S-JTSK / Czech Republic). See issue #1408.
 *
 * Computed by finite difference through proj4 so it works for any projection
 * (TM, LCC, Krovak, ...) without per-projection convergence formulae. A
 * geographic (longlat) def has zero convergence by definition.
 */
export function computeGridConvergence(
  projDef: string,
  easting: number,
  northing: number,
  lon: number,
  lat: number,
): number {
  // Geographic CRS: lat/lon is already true-north aligned.
  if (/\+proj=longlat\b/.test(projDef)) return 0;
  // Near the poles the local east/metre scale degenerates; skip.
  if (Math.abs(lat) > 89.9) return 0;

  const step = 1.0; // one projected-metre step along grid north
  let lon2: number, lat2: number;
  try {
    [lon2, lat2] = proj4(projectedDefinitionInMetres(projDef), 'WGS84', [easting, northing + step]);
  } catch (err) {
    // Zero is not a neutral answer here: it is indistinguishable from a
    // genuinely zero convergence, so the model silently keeps its GRID
    // alignment inside Cesium's TRUE-north ENU frame — a rotation of up to ~3°
    // (UTM zone edge) or ~7-8° (Krovak). Called once per model, so logging it
    // costs nothing and names the cause if it ever happens.
    console.warn(
      `[cesium] grid convergence unavailable for ${projDef}; the model is placed `
      + 'grid-aligned in a true-north frame (rotation up to a few degrees).',
      err,
    );
    return 0;
  }
  if (!Number.isFinite(lon2) || !Number.isFinite(lat2)) return 0;

  // True-ENU components of the grid-north step (small-angle local metres).
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  const east = (lon2 - lon) * mPerDegLon;
  const north = (lat2 - lat) * mPerDegLat;
  // grid-north's bearing measured from true north is atan2(east, north) = -gamma.
  return Math.atan2(-east, north);
}
