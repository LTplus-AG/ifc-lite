/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The package's main contract: resolve a CRS once, then convert points
 * between it and WGS84 and read the local grid factors.
 */

import { reportCrsDiagnostic } from './diagnostics.js';
import {
  createEngineState,
  defaultEngineState,
  type CrsDatumShift,
  type EngineState,
} from './engine-state.js';
import type { CrsLoaders } from './loaders.js';
import { projectedLinearUnit, type LinearUnit } from './projected-units.js';
import { computeGridPointFactors, isGeographicProj4, type GridPointFactors } from './proj4-utils.js';
import { coordinatesToLatLon, latLonToCoordinates } from './reproject-point.js';
import { declaredEpsgCode, resolveDefinition } from './resolve-projection.js';

export type { CrsDatumShift } from './engine-state.js';
export type { LinearUnit } from './projected-units.js';

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
 * A point in the transformer's CRS or in WGS84. `x`/`y` are easting/northing
 * in metres for a projected CRS (whatever its native unit, see
 * {@link CrsTransformer.linearUnit}) and longitude/latitude in degrees for a
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
  /**
   * The unit the CRS itself is defined in, and its length in metres: the
   * US survey foot (1200/3937 m) for a State Plane CRS in feet. Coordinates
   * going into and coming out of this transformer are still metres; divide
   * by `toMetres` to get the CRS's own numbers. `null` for a geographic CRS,
   * or when the definition names a unit this package does not know.
   */
  readonly linearUnit: LinearUnit | null;
  /** The EPSG code the input resolved through, when it named one. */
  readonly epsg: number | null;
  /** How the datum shift of {@link definition} is carried out. Fixed for this transformer. */
  readonly datumShift: CrsDatumShift;
  /**
   * CRS coordinates to WGS84 `[longitude, latitude]` in degrees. `null` when
   * the input (a given `z` included) is not finite, lies outside a loaded grid's coverage or the
   * extent the WKT declares, or does not map to a valid position.
   *
   * `z` is returned unchanged: there is no vertical transformation, so a
   * height above the CRS's vertical datum stays exactly that.
   */
  toWgs84(coordinate: Coordinate): [number, number] | [number, number, number] | null;
  /**
   * WGS84 `[longitude, latitude]` in degrees to CRS coordinates. `null` with
   * the same refusals as {@link toWgs84}: a non-finite or out-of-range input,
   * a position outside a loaded grid's coverage or the WKT's declared extent.
   * `z` is returned unchanged.
   */
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

/** Options of {@link createCrsEngine}. */
export interface CrsEngineOptions {
  /** The loaders this engine may call. Absent: none, so no network request. */
  loaders?: CrsLoaders;
}

/** An engine with its own loaders and caches; see {@link createCrsEngine}. */
export interface CrsEngine {
  resolveCrs(input: CrsInput): Promise<CrsTransformer | null>;
}

/**
 * Make an engine with its own loaders and its own caches. Definitions and
 * datum grids it resolves are not shared with the default engine
 * (`resolveCrs`) or any other engine, and theirs are not visible to it, so a
 * server can resolve for several tenants with different loaders side by side.
 * Keep the engine for as long as its loaders apply: each one loads a grid
 * once and keeps it.
 */
export function createCrsEngine(options: CrsEngineOptions = {}): CrsEngine {
  const state = createEngineState(options.loaders ?? {});
  return { resolveCrs: (input) => resolveCrsWith(state, input) };
}

/**
 * Resolve a CRS to a transformer through the default engine, whose loaders
 * `configureCrsLoaders` sets. `null` when it cannot be resolved.
 *
 * Precedence: a readable `wkt` defines the CRS (an EPSG identifier inside it
 * resolves through the registry); otherwise `epsg`; otherwise `name`.
 *
 * Resolution reads the bundled EPSG index, the name aliases and the WKT. It
 * touches the network only through loaders the host installed.
 */
export function resolveCrs(input: CrsInput): Promise<CrsTransformer | null> {
  return resolveCrsWith(defaultEngineState(), input);
}

async function resolveCrsWith(state: EngineState, input: CrsInput): Promise<CrsTransformer | null> {
  const epsg = input.epsg === undefined ? undefined : epsgName(input.epsg);
  // An unreadable `epsg` is refused, unless a readable WKT defines the CRS:
  // the WKT comes first, and lower-priority input cannot veto it.
  if (epsg === null && !input.wkt) return null;
  const descriptor = { name: epsg === null ? undefined : epsg ?? input.name, wellKnownText: input.wkt };
  const resolved = await resolveDefinition(descriptor, state);
  if (!resolved) return null;

  const { definition, datumShift } = resolved;
  const code = declaredEpsgCode(descriptor);
  const geographic = isGeographicProj4(definition);
  return {
    definition,
    kind: geographic ? 'geographic' : 'projected',
    linearUnit: geographic ? null : projectedLinearUnit(definition),
    epsg: code === null ? null : Number(code),
    datumShift,
    toWgs84([x, y, z]) {
      if (z !== undefined && !Number.isFinite(z)) return null;
      const position = coordinatesToLatLon(definition, x, y);
      return position && withZ(position.lon, position.lat, z);
    },
    fromWgs84([lon, lat, z]) {
      if (z !== undefined && !Number.isFinite(z)) return null;
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
        reportCrsDiagnostic('[reproject] grid factors could not be evaluated', error);
        return null;
      }
    },
  };
}
