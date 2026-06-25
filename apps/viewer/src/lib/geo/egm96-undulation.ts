/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * EGM96 geoid-undulation lookup.
 *
 * IFC georeferenced altitudes (`IfcMapConversion.OrthogonalHeight`) are
 * orthometric — heights above the geoid / mean sea level. Cesium positions
 * geometry by ellipsoidal height (height above the WGS84 ellipsoid). The two
 * differ by the geoid undulation `N` (geoid height above the ellipsoid):
 *
 *     ellipsoidalHeight = orthometricHeight + N(lat, lon)
 *
 * Skipping `N` drops the model ~40-50 m in Central Europe (N ≈ +45 m in
 * Czechia, ≈ +49 m in Switzerland), burying it under the world terrain (#1355).
 *
 * We bilinearly interpolate a bundled 1° EGM96 grid — sub-metre accurate and
 * deterministic, with no network call. This corrects a gross placement error,
 * not a survey-grade datum transform.
 */

import { EGM96_GRID } from './egm96-undulation-data';

let grid: Int16Array | null = null;

function getGrid(): Int16Array {
  if (grid) return grid;
  const bin = atob(EGM96_GRID.dataB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Stored little-endian; read explicitly so the decode is endianness-safe.
  const view = new DataView(bytes.buffer);
  const out = new Int16Array(EGM96_GRID.nLat * EGM96_GRID.nLon);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  grid = out;
  return out;
}

/** Normalise a longitude into [-180, 180]. */
function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * EGM96 geoid undulation `N` in metres at the given WGS84 lat/lon (degrees).
 * Returns the height of the geoid above the ellipsoid — add it to an
 * orthometric height to get an ellipsoidal height.
 */
export function egm96Undulation(latDeg: number, lonDeg: number): number {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return 0;
  const { latStart, lonStart, step, nLat, nLon } = EGM96_GRID;
  const g = getGrid();

  const lat = Math.max(-90, Math.min(90, latDeg));
  const lon = wrapLon(lonDeg);

  const fi = (lat - latStart) / step;
  const fj = (lon - lonStart) / step;

  let i0 = Math.floor(fi);
  let j0 = Math.floor(fj);
  i0 = Math.max(0, Math.min(nLat - 2, i0));
  j0 = Math.max(0, Math.min(nLon - 2, j0));
  const di = fi - i0;
  const dj = fj - j0;

  const at = (i: number, j: number) => g[i * nLon + j];
  const n00 = at(i0, j0);
  const n01 = at(i0, j0 + 1);
  const n10 = at(i0 + 1, j0);
  const n11 = at(i0 + 1, j0 + 1);

  const top = n00 + (n01 - n00) * dj;
  const bot = n10 + (n11 - n10) * dj;
  const cm = top + (bot - top) * di;
  return cm / 100; // stored centimetres → metres
}
