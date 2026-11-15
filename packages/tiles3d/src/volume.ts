/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Culling of 3D Tiles bounding volumes against a WGS84 query region.
 *
 * `region` volumes are compared in geodetic space and, per the specification,
 * ignore tile transforms. `box` and `sphere` volumes live in the tile's frame:
 * the composed transform maps them into the tileset root frame, which for a
 * geospatial tileset is ECEF. There they are tested against an oriented box
 * that conservatively encloses the query region (separating-axis test), so the
 * cull can keep a tile that does not intersect but never drops one that does.
 */

import { enuToEcefMatrix, geodeticToEcef, WGS84_A } from './geodesy.js';
import { type Mat4, maxScale, transformPoint, transformVector } from './matrix.js';
import type { BoundingVolumeJson } from './tileset-types.js';

/** Query region in WGS84 degrees. `west > east` crosses the antimeridian. */
export interface GeoRegion {
  west: number;
  south: number;
  east: number;
  north: number;
  /** Ellipsoidal metres; default -1000. */
  minHeight?: number;
  /** Ellipsoidal metres; default 10000. */
  maxHeight?: number;
}

const DEFAULT_MIN_H = -1000;
const DEFAULT_MAX_H = 10000;
const RAD = 180 / Math.PI;
const SAMPLES = 9;

type Vec3 = [number, number, number];

/** Prepared query: lon/lat intervals plus an ECEF oriented box enclosing the region. */
export interface PreparedRegion {
  readonly region: GeoRegion;
  readonly lonSpans: Array<[number, number]>;
  readonly minH: number;
  readonly maxH: number;
  /** ENU frame at the region centre (column-major), and the enclosing box in that frame. */
  readonly enu: Mat4;
  readonly boxMin: Vec3;
  readonly boxMax: Vec3;
}

function lonSpans(west: number, east: number): Array<[number, number]> {
  return west <= east ? [[west, east]] : [[west, 180], [-180, east]];
}

export function prepareRegion(region: GeoRegion): PreparedRegion {
  const { west, south, east, north } = region;
  for (const [k, v] of Object.entries({ west, south, east, north })) {
    if (!Number.isFinite(v)) throw new RangeError(`region.${k} must be a finite number of degrees`);
  }
  if (Math.abs(west) > 180 || Math.abs(east) > 180) throw new RangeError('region longitudes must lie in [-180, 180]');
  if (Math.abs(south) > 90 || Math.abs(north) > 90 || south > north) {
    throw new RangeError('region latitudes must lie in [-90, 90] with south <= north');
  }
  const minH = region.minHeight ?? DEFAULT_MIN_H;
  const maxH = region.maxHeight ?? DEFAULT_MAX_H;
  if (!(minH <= maxH)) throw new RangeError('region.minHeight must not exceed region.maxHeight');

  const span = west <= east ? east - west : east + 360 - west;
  let lonC = west + span / 2;
  if (lonC > 180) lonC -= 360;
  const latC = (south + north) / 2;
  const enu = enuToEcefMatrix(lonC, latC, 0);
  const boxMin: Vec3 = [Infinity, Infinity, Infinity];
  const boxMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < SAMPLES; i++) {
    const lon = west + (span * i) / (SAMPLES - 1);
    for (let j = 0; j < SAMPLES; j++) {
      const lat = south + ((north - south) * j) / (SAMPLES - 1);
      for (const h of [minH, maxH]) {
        const local = ecefToEnu(enu, geodeticToEcef(lon, lat, h));
        for (let a = 0; a < 3; a++) {
          boxMin[a] = Math.min(boxMin[a], local[a]);
          boxMax[a] = Math.max(boxMax[a], local[a]);
        }
      }
    }
  }
  // The ellipsoid bulges between samples by at most the sagitta of a chord
  // spanning one sample step; pad by it (plus a metre) so the box encloses.
  const step = (Math.max(span, north - south) / RAD / (SAMPLES - 1)) * (WGS84_A + maxH);
  // 6,335 km is the smallest WGS84 radius of curvature (meridional, at the equator).
  const pad = (step * step) / (8 * 6_335_000) + 1;
  for (let a = 0; a < 3; a++) {
    boxMin[a] -= pad;
    boxMax[a] += pad;
  }
  return { region, lonSpans: lonSpans(west, east), minH, maxH, enu, boxMin, boxMax };
}

/**
 * Grow a region by `metres` on every side (approximate metres per degree on
 * the sphere; clamps at the poles, widens to all longitudes when it wraps).
 */
export function expandRegion(region: GeoRegion, metres: number): GeoRegion {
  if (!(metres > 0)) return region;
  const dLat = metres / 111_320;
  const south = Math.max(-90, region.south - dLat);
  const north = Math.min(90, region.north + dLat);
  const maxAbsLat = Math.max(Math.abs(south), Math.abs(north));
  const cos = Math.cos((maxAbsLat * Math.PI) / 180);
  const dLon = cos > 1e-6 ? metres / (111_320 * cos) : 360;
  const span = region.west <= region.east ? region.east - region.west : region.east + 360 - region.west;
  if (span + 2 * dLon >= 360) return { ...region, south, north, west: -180, east: 180 };
  const wrap = (v: number): number => (v < -180 ? v + 360 : v > 180 ? v - 360 : v);
  return { ...region, south, north, west: wrap(region.west - dLon), east: wrap(region.east + dLon) };
}

function ecefToEnu(enu: Mat4, p: readonly number[]): Vec3 {
  const dx = p[0] - enu[12], dy = p[1] - enu[13], dz = p[2] - enu[14];
  // Rotation is orthonormal: inverse = transpose (columns are the ENU axes).
  return [
    enu[0] * dx + enu[1] * dy + enu[2] * dz,
    enu[4] * dx + enu[5] * dy + enu[6] * dz,
    enu[8] * dx + enu[9] * dy + enu[10] * dz,
  ];
}

function rotToEnu(enu: Mat4, v: readonly number[]): Vec3 {
  return [
    enu[0] * v[0] + enu[1] * v[1] + enu[2] * v[2],
    enu[4] * v[0] + enu[5] * v[1] + enu[6] * v[2],
    enu[8] * v[0] + enu[9] * v[1] + enu[10] * v[2],
  ];
}

function overlaps(a: Array<[number, number]>, b: Array<[number, number]>): boolean {
  return a.some(([a0, a1]) => b.some(([b0, b1]) => a0 <= b1 && b0 <= a1));
}

/** `region` volume (radians) against the query. Transforms never apply to regions. */
export function regionIntersects(q: PreparedRegion, region: readonly number[]): boolean {
  const [w, s, e, n, h0, h1] = region;
  if (!(s * RAD <= q.region.north && q.region.south <= n * RAD)) return false;
  if (!overlaps(lonSpans(w * RAD, e * RAD), q.lonSpans)) return false;
  return h0 <= q.maxH && q.minH <= h1;
}

/** Oriented box (centre + three half-axis vectors, already in ECEF) against the query box. */
function boxIntersects(q: PreparedRegion, center: Vec3, axes: Vec3[]): boolean {
  const c = ecefToEnu(q.enu, center);
  const half: Vec3 = [(q.boxMax[0] - q.boxMin[0]) / 2, (q.boxMax[1] - q.boxMin[1]) / 2, (q.boxMax[2] - q.boxMin[2]) / 2];
  const qc: Vec3 = [q.boxMin[0] + half[0], q.boxMin[1] + half[1], q.boxMin[2] + half[2]];
  const d: Vec3 = [c[0] - qc[0], c[1] - qc[1], c[2] - qc[2]];
  const b = axes.map((v) => rotToEnu(q.enu, v));
  const qAxes: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const candidates: Vec3[] = [...qAxes, ...b, cross(b[0], b[1]), cross(b[1], b[2]), cross(b[2], b[0])];
  for (const a of qAxes) for (const v of b) candidates.push(cross(a, v));
  for (const n of candidates) {
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-9) continue;
    const rq = (half[0] * Math.abs(n[0]) + half[1] * Math.abs(n[1]) + half[2] * Math.abs(n[2])) / len;
    const rb = (Math.abs(dot(b[0], n)) + Math.abs(dot(b[1], n)) + Math.abs(dot(b[2], n))) / len;
    if (Math.abs(dot(d, n)) / len > rq + rb) return false;
  }
  return true;
}

function sphereIntersects(q: PreparedRegion, center: Vec3, radius: number): boolean {
  const c = ecefToEnu(q.enu, center);
  let d2 = 0;
  for (let a = 0; a < 3; a++) {
    const v = c[a] < q.boxMin[a] ? q.boxMin[a] - c[a] : c[a] > q.boxMax[a] ? c[a] - q.boxMax[a] : 0;
    d2 += v * v;
  }
  return d2 <= radius * radius;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Does a bounding volume, under the composed tile transform `toRoot`
 * (tile frame -> tileset root frame, assumed ECEF), intersect the query?
 * Returns `undefined` when the volume has none of region/box/sphere, so the
 * caller can report it instead of guessing.
 */
export function volumeIntersects(q: PreparedRegion, volume: BoundingVolumeJson, toRoot: Mat4): boolean | undefined {
  if (volume.region && volume.region.length >= 6) return regionIntersects(q, volume.region);
  if (volume.box && volume.box.length >= 12) {
    const v = volume.box;
    const center = transformPoint(toRoot, v[0], v[1], v[2]);
    const axes = [0, 1, 2].map((i) => transformVector(toRoot, v[3 + i * 3], v[4 + i * 3], v[5 + i * 3]));
    return boxIntersects(q, center, axes);
  }
  if (volume.sphere && volume.sphere.length >= 4) {
    const v = volume.sphere;
    return sphereIntersects(q, transformPoint(toRoot, v[0], v[1], v[2]), v[3] * maxScale(toRoot));
  }
  return undefined;
}
