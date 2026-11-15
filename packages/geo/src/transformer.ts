/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The package's main contract: resolve a CRS once, then convert points
 * between it and WGS84 and read the local grid factors.
 */

import { approximateProjectionCodes, refusedProjectionCodes } from './sanitize-proj4.js';
import { computeGridPointFactors, isGeographicProj4, type GridPointFactors } from './proj4-utils.js';
import { coordinatesToLatLon, latLonToCoordinates } from './reproject-point.js';
import { declaredEpsgCode, resolveProjection } from './resolve-projection.js';

/** What identifies a CRS. At least one field; see {@link resolveCrs} for precedence. */
export interface CrsInput {
  /** EPSG code: `2056`, `'2056'` or `'EPSG:2056'`. */
  epsg?: number | string;
  /** `EPSG:<code>` or a well-known alias such as `LV95`, `RD New`, `British National Grid`. */
  name?: string;
  /** WKT1 or WKT2 definition, single or compound. */
  wkt?: string;
}

/**
 * How the horizontal datum shift to WGS84 is carried out.
 *
 * - `as-defined`: the CRS's own operation is in use: the bundled EPSG
 *   parameters, a loaded precision grid, or what the WKT states.
 * - `helmert-approximation`: the CRS needs a datum-shift grid that was not
 *   available (no grid loader installed, or the load failed), and a published
 *   7-parameter shift stands in. Expect metre-level differences.
 * - `grid-unavailable`: the CRS needs a grid that is not available and there
 *   is no known 7-parameter replacement, so no datum shift is applied.
 *   Positions can be tens to hundreds of metres off.
 */
export type CrsDatumShift = 'as-defined' | 'helmert-approximation' | 'grid-unavailable';

/**
 * A point in the transformer's CRS or in WGS84. `x`/`y` are easting/northing
 * in metres for a projected CRS and longitude/latitude in degrees for a
 * geographic one and for WGS84: east or longitude always comes first.
 */
export type Coordinate = readonly [x: number, y: number, z?: number];

export interface CrsTransformer {
  /**
   * The proj4 definition in use. Either a proj4 string or, for a WKT, a
   * handle registered with this package's proj4 instance; treat it as opaque.
   */
  readonly definition: string;
  /** `geographic`: coordinates are degrees. `projected`: metres. */
  readonly kind: 'projected' | 'geographic';
  /** The EPSG code the input resolved through, when it named one. */
  readonly epsg: number | null;
  readonly datumShift: CrsDatumShift;
  /**
   * CRS coordinates to WGS84 `[longitude, latitude]` in degrees. `null` when
   * the input is not finite, lies outside a loaded grid's coverage or the
   * extent the WKT declares, or does not map to a valid position.
   *
   * `z` is returned unchanged: there is no vertical transformation, so a
   * height above the CRS's vertical datum stays exactly that.
   */
  toWgs84(coordinate: Coordinate): [number, number] | [number, number, number] | null;
  /** WGS84 `[longitude, latitude]` in degrees to CRS coordinates. `z` is returned unchanged. */
  fromWgs84(coordinate: Coordinate): [number, number] | [number, number, number] | null;
  /**
   * Grid convergence (`gamma`, radians, counter-clockwise positive: grid
   * north is true north rotated by `+gamma`) and point scale factor
   * (`pointScale`, grid distance over WGS84-ellipsoid distance) at a point of
   * a projected CRS. `null` for a geographic CRS, within 0.1 degrees of a
   * pole, or where the projection cannot be evaluated.
   */
  gridFactors(x: number, y: number): GridPointFactors | null;
}

function epsgName(epsg: number | string): string | null {
  const code = /^(?:EPSG\s*:\s*)?(\d+)$/i.exec(String(epsg).trim())?.[1];
  return code ? `EPSG:${code}` : null;
}

function withZ(x: number, y: number, z: number | undefined): [number, number] | [number, number, number] {
  return z === undefined ? [x, y] : [x, y, z];
}

/**
 * Resolve a CRS to a transformer. `null` when it cannot be resolved.
 *
 * Precedence: a readable `wkt` defines the CRS (an EPSG identifier inside it
 * resolves through the registry); otherwise `epsg`; otherwise `name`.
 *
 * Resolution reads the bundled EPSG index, the name aliases and the WKT. It
 * touches the network only through loaders the host installed with
 * `configureCrsLoaders`.
 */
export async function resolveCrs(input: CrsInput): Promise<CrsTransformer | null> {
  const epsg = input.epsg === undefined ? undefined : epsgName(input.epsg);
  if (epsg === null) return null;
  const descriptor = { name: epsg ?? input.name, wellKnownText: input.wkt };
  const definition = await resolveProjection(descriptor);
  if (!definition) return null;

  const code = declaredEpsgCode(descriptor);
  const geographic = isGeographicProj4(definition);
  return {
    definition,
    kind: geographic ? 'geographic' : 'projected',
    epsg: code === null ? null : Number(code),
    datumShift: code !== null && refusedProjectionCodes.has(code)
      ? 'grid-unavailable'
      : code !== null && approximateProjectionCodes.has(code) ? 'helmert-approximation' : 'as-defined',
    toWgs84([x, y, z]) {
      const position = coordinatesToLatLon(definition, x, y);
      return position && withZ(position.lon, position.lat, z);
    },
    fromWgs84([lon, lat, z]) {
      const position = latLonToCoordinates(definition, lon, lat);
      return position && withZ(position.x, position.y, z);
    },
    gridFactors(x, y) {
      if (geographic) return null;
      const position = coordinatesToLatLon(definition, x, y);
      if (!position || Math.abs(position.lat) >= 89.9) return null;
      try {
        return computeGridPointFactors(definition, x, y);
      } catch (error) {
        console.warn('[reproject] grid factors could not be evaluated', error);
        return null;
      }
    },
  };
}
