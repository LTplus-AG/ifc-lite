/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GeoWarp: viewer coordinates to the anchor's east/north/up frame, point by
 * point, through the map projection.
 *
 * The anchor placement draws the model in one tangent plane (`cesium-bridge`),
 * which ignores Earth curvature (1 m at 5 km), the change of projection scale
 * and convergence across the site, geoid slope and datum-grid shape. This
 * module computes where each point actually is:
 *
 *   viewer → IFC → map (E, N, H) → proj4 → (lon, lat), h = H + N_geoid
 *     → ECEF → anchor ENU
 *
 * `createGeoMapping` does that exactly for one point. `createLatticeWarp`
 * samples it on a lattice over a bounding box (100 m cells, two height levels)
 * and interpolates, which is how a whole model is warped at about 0.05 µs per
 * vertex instead of 0.4-0.6 µs for proj4 per vertex. The warp is exactly
 * linear in viewer height (a vertex's lat/lon depends on its map E/N only, and
 * ECEF is linear in h at fixed lat/lon), so two levels are exact vertically;
 * horizontally the bilinear residual is about c²/(8R), 0.2 mm at 100 m cells.
 *
 * Map coordinates follow `ground-scale.ts`: a grid-coordinate source (rigid
 * operation, map-absolute geometry, Scaled with factors = k_c) projects the
 * authored map coordinates as they are. True-length geometry (plain
 * IfcMapConversion) projects E_a + k_c·(E − E_a) about the anchor, so it keeps
 * its true lengths at the anchor instead of shrinking by the grid scale.
 */

import proj4 from 'proj4';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { projectedDefinitionInMetres } from './proj4-utils';
import { ifcToViewerAxes } from './coordinate-frame';

const WGS84_A = 6378137;
const WGS84_E2 = 0.0066943799901413165;
const DEG = Math.PI / 180;

/** Placement of the model's anchor, as the bridge computed it. */
export interface GeoWarpAnchor {
  longitude: number;
  latitude: number;
  /** Ellipsoidal height of the anchor (what Cesium is given). */
  height: number;
  /** Authored orthometric height at the anchor (`ifcOriginHeight`). */
  ifcOriginHeight: number;
  /** Geoid undulation applied at the anchor (0 when heights are ellipsoidal). */
  geoidUndulation: number;
  /** Map coordinates of the anchor, metres. */
  easting: number;
  northing: number;
}

export interface GeoMappingParams {
  /** Resolved proj4 definition of the projected CRS (WKT names and nadgrids included). */
  projDef: string;
  /** Effective conversion (map-absolute neutralised), offsets in metres. */
  eastingsM: number;
  northingsM: number;
  orthogonalHeightM: number;
  /** Unit X axis direction (XAxisAbscissa, XAxisOrdinate). */
  axis: { a: number; b: number };
  /** Effective per-axis scales for metre viewer geometry. */
  scales: { x: number; y: number; z: number };
  coordinateInfo: CoordinateInfo | undefined;
  anchor: GeoWarpAnchor;
  /** k_c at the anchor. */
  combinedScaleFactor: number;
  /** True for grid-coordinate sources: project the authored map coordinates. */
  gridCoordinates: boolean;
  /** Geoid undulation N at (lat, lon) degrees; return 0 when heights are ellipsoidal. */
  geoid: (latDeg: number, lonDeg: number) => number;
}

/** One point through the full chain. */
export interface GeoPoint {
  longitude: number;
  latitude: number;
  /** Authored orthometric height H (the IFC contract, before the geoid). */
  orthometricHeight: number;
  /** Ellipsoidal height h as placed on the globe. */
  ellipsoidalHeight: number;
}

export interface GeoMapping {
  readonly anchor: GeoWarpAnchor;
  /** Map E/N (metres) the point is projected from. */
  toMap(vx: number, vy: number, vz: number): { easting: number; northing: number; height: number };
  /** Exact geodetic position, or null when proj4 cannot place the point. */
  toGeodetic(vx: number, vy: number, vz: number): GeoPoint | null;
  /** Exact anchor-ENU position written to `out` (e, n, u); false when unplaceable. */
  toEnu(vx: number, vy: number, vz: number, out: Float64Array | number[]): boolean;
}

/** WGS84 geodetic (degrees, metres) to ECEF. */
function geodeticToEcef(latDeg: number, lonDeg: number, h: number, out: Float64Array | number[]): void {
  const la = latDeg * DEG;
  const lo = lonDeg * DEG;
  const sl = Math.sin(la);
  const cl = Math.cos(la);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sl * sl);
  out[0] = (n + h) * cl * Math.cos(lo);
  out[1] = (n + h) * cl * Math.sin(lo);
  out[2] = (n * (1 - WGS84_E2) + h) * sl;
}

/** ECEF → ENU at a geodetic anchor, as a reusable closure. */
export function ecefToEnuAt(latDeg: number, lonDeg: number, h: number) {
  const o = [0, 0, 0];
  geodeticToEcef(latDeg, lonDeg, h, o);
  const la = latDeg * DEG;
  const lo = lonDeg * DEG;
  const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
  return (x: number, y: number, z: number, out: Float64Array | number[]) => {
    const dx = x - o[0], dy = y - o[1], dz = z - o[2];
    out[0] = -so * dx + co * dy;
    out[1] = -sl * co * dx - sl * so * dy + cl * dz;
    out[2] = cl * co * dx + cl * so * dy + sl * dz;
  };
}

export function createGeoMapping(p: GeoMappingParams): GeoMapping {
  const def = projectedDefinitionInMetres(p.projDef);
  const shift = p.coordinateInfo?.originShift ?? { x: 0, y: 0, z: 0 };
  const rtc = ifcToViewerAxes(p.coordinateInfo?.wasmRtcOffset ?? { x: 0, y: 0, z: 0 });
  const { a, b } = p.axis;
  const { x: sx, y: sy, z: sz } = p.scales;
  const { anchor } = p;
  const k = p.gridCoordinates ? 1 : p.combinedScaleFactor;
  const toEnuFromEcef = ecefToEnuAt(anchor.latitude, anchor.longitude, anchor.height);
  const ecef = [0, 0, 0];

  function toMap(vx: number, vy: number, vz: number) {
    const x = vx + shift.x + rtc.x;
    const y = -(vz + shift.z + rtc.z);
    const z = vy + shift.y + rtc.y;
    const e = p.eastingsM + a * sx * x - b * sy * y;
    const n = p.northingsM + b * sx * x + a * sy * y;
    return {
      easting: anchor.easting + k * (e - anchor.easting),
      northing: anchor.northing + k * (n - anchor.northing),
      height: p.orthogonalHeightM + sz * z,
    };
  }

  function toGeodetic(vx: number, vy: number, vz: number): GeoPoint | null {
    const m = toMap(vx, vy, vz);
    let lon: number, lat: number;
    try {
      [lon, lat] = proj4(def, 'WGS84', [m.easting, m.northing]);
    } catch (error) {
      console.warn('[geo-warp] projection failed', error);
      return null;
    }
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    // Anchor-relative, so a terrain/placement override on the anchor carries over.
    const h = anchor.height + (m.height - anchor.ifcOriginHeight) + (p.geoid(lat, lon) - anchor.geoidUndulation);
    return { longitude: lon, latitude: lat, orthometricHeight: m.height, ellipsoidalHeight: h };
  }

  function toEnu(vx: number, vy: number, vz: number, out: Float64Array | number[]): boolean {
    const g = toGeodetic(vx, vy, vz);
    if (!g) return false;
    geodeticToEcef(g.latitude, g.longitude, g.ellipsoidalHeight, ecef);
    toEnuFromEcef(ecef[0], ecef[1], ecef[2], out);
    return true;
  }

  return { anchor, toMap, toGeodetic, toEnu };
}

/** Axis-aligned viewer-space box (Y up). */
export interface ViewerBounds {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface LatticeWarp {
  /** Interpolated anchor-ENU position of a viewer point. */
  warp(vx: number, vy: number, vz: number, out: Float64Array | number[]): void;
  /** Lattice spacing actually used (metres of viewer x/z). */
  readonly cellSize: number;
  readonly nodeCount: number;
}

/** Nodes above this make the cell grow: about 1e6 proj4 calls is ~0.5 s. */
const MAX_LATTICE_NODES = 1_000_000;
const DEFAULT_LATTICE_CELL_M = 100;

/**
 * Sample `mapping` on a lattice over `bounds` (horizontal cells of `cellSize`,
 * grown when the node budget would be exceeded; two height levels) and return
 * the interpolating warp. Points outside the box extrapolate from the edge
 * cell, which stays exact vertically and degrades horizontally like c·d/R.
 * Returns null when any node cannot be projected.
 */
export function createLatticeWarp(
  mapping: GeoMapping,
  bounds: ViewerBounds,
  cellSize = DEFAULT_LATTICE_CELL_M,
): LatticeWarp | null {
  const x0 = bounds.min.x, z0 = bounds.min.z;
  const w = Math.max(bounds.max.x - x0, 0), d = Math.max(bounds.max.z - z0, 0);
  let cell = cellSize;
  while (((Math.ceil(w / cell) + 1) * (Math.ceil(d / cell) + 1)) * 2 > MAX_LATTICE_NODES) cell *= 1.5;
  const nx = Math.ceil(w / cell) + 1;
  const nz = Math.ceil(d / cell) + 1;
  // Two levels a metre apart at least, so the vertical slope is well conditioned.
  const y0 = bounds.min.y;
  const dy = Math.max(bounds.max.y - y0, 1);
  const nodes = new Float64Array(nx * nz * 2 * 3);
  const tmp = [0, 0, 0];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      for (let l = 0; l < 2; l++) {
        if (!mapping.toEnu(x0 + i * cell, y0 + l * dy, z0 + j * cell, tmp)) return null;
        const o = ((j * nx + i) * 2 + l) * 3;
        nodes[o] = tmp[0]; nodes[o + 1] = tmp[1]; nodes[o + 2] = tmp[2];
      }
    }
  }
  const imax = Math.max(nx - 2, 0);
  const jmax = Math.max(nz - 2, 0);
  const stepI = nx > 1 ? 1 : 0;
  const stepJ = nz > 1 ? nx : 0;

  function warp(vx: number, vy: number, vz: number, out: Float64Array | number[]): void {
    const gx = (vx - x0) / cell;
    const gz = (vz - z0) / cell;
    const i = Math.min(Math.max(Math.floor(gx), 0), imax);
    const j = Math.min(Math.max(Math.floor(gz), 0), jmax);
    const fx = nx > 1 ? gx - i : 0;
    const fz = nz > 1 ? gz - j : 0;
    const fy = (vy - y0) / dy;
    const b00 = (j * nx + i) * 6;
    const b10 = b00 + stepI * 6;
    const b01 = b00 + stepJ * 6;
    const b11 = b01 + stepI * 6;
    const w00 = (1 - fx) * (1 - fz), w10 = fx * (1 - fz), w01 = (1 - fx) * fz, w11 = fx * fz;
    for (let c = 0; c < 3; c++) {
      const lo = w00 * nodes[b00 + c] + w10 * nodes[b10 + c] + w01 * nodes[b01 + c] + w11 * nodes[b11 + c];
      const hi = w00 * nodes[b00 + 3 + c] + w10 * nodes[b10 + 3 + c] + w01 * nodes[b01 + 3 + c] + w11 * nodes[b11 + 3 + c];
      out[c] = lo + (hi - lo) * fy;
    }
  }

  return { warp, cellSize: cell, nodeCount: nx * nz * 2 };
}

/**
 * Local linearisation of a warp at a viewer point: `value` (anchor ENU) and the
 * 3x3 Jacobian `jacobian[row][col]` = d ENU_row / d viewer_col (x, y, z), by
 * central differences of `step` metres.
 */
export function linearizeWarp(
  warp: (vx: number, vy: number, vz: number, out: number[]) => boolean | void,
  vx: number, vy: number, vz: number,
  step = 1,
): { value: number[]; jacobian: number[][] } | null {
  const value = [0, 0, 0];
  if (warp(vx, vy, vz, value) === false) return null;
  const jacobian = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const plus = [0, 0, 0], minus = [0, 0, 0];
  for (let col = 0; col < 3; col++) {
    const p = [vx, vy, vz], m = [vx, vy, vz];
    p[col] += step; m[col] -= step;
    if (warp(p[0], p[1], p[2], plus) === false || warp(m[0], m[1], m[2], minus) === false) return null;
    for (let row = 0; row < 3; row++) jacobian[row][col] = (plus[row] - minus[row]) / (2 * step);
  }
  return { value, jacobian };
}

/**
 * Normal transform for a linear map J: the cofactor matrix, det(J)·J^-T. It
 * maps surface normals correctly under non-uniform scale (Scale x FactorZ) and
 * needs no inversion; callers normalise the result.
 */
export function normalMatrix(j: number[][]): number[][] {
  const c = (r0: number, r1: number, c0: number, c1: number) => j[r0][c0] * j[r1][c1] - j[r0][c1] * j[r1][c0];
  return [
    [c(1, 2, 1, 2), -c(1, 2, 0, 2), c(1, 2, 0, 1)],
    [-c(0, 2, 1, 2), c(0, 2, 0, 2), -c(0, 2, 0, 1)],
    [c(0, 1, 1, 2), -c(0, 1, 0, 2), c(0, 1, 0, 1)],
  ];
}
