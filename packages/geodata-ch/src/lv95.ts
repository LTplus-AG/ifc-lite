/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LV95 helpers and swisstopo's published APPROXIMATE formulas between LV95
 * and WGS84 ("Approximate formulas for the transformation between Swiss
 * projection coordinates and WGS84", swisstopo; stated accuracy about 1 m).
 * A round trip through both measured 0.4 m at Bern and 2.7 m near Geneva.
 *
 * These exist only to build padded WGS84 query boxes for services that want
 * them (the STAC API's `bbox`). They are never applied to returned geometry.
 * Exact reprojection is out of scope for this package.
 */

import type { BBox, Geometry, MultiPolygonGeometry, PolygonGeometry, Position } from './contracts.js';

export const LV95 = 'EPSG:2056';
/** LN02 heights, the vertical reference of swissALTI3D and swissBUILDINGS3D. */
export const LN02 = 'EPSG:5728';

/** Rough LV95 envelope of Switzerland and Liechtenstein with a margin. */
const LV95_EASTING = [2_420_000, 2_900_000] as const;
const LV95_NORTHING = [1_030_000, 1_350_000] as const;

export function isLv95Easting(x: number): boolean {
  return x >= LV95_EASTING[0] && x <= LV95_EASTING[1];
}

export function isLv95Northing(y: number): boolean {
  return y >= LV95_NORTHING[0] && y <= LV95_NORTHING[1];
}

/** True when `(x, y)` fits LV95 only with the two values exchanged. */
function looksSwapped(x: number, y: number): boolean {
  return isLv95Easting(y) && isLv95Northing(x);
}

const SWAPPED_HINT =
  'the arguments look swapped: LV95 easting (x, ~2.4e6-2.9e6) comes first, northing (y, ~1.03e6-1.35e6) second';

/**
 * Throws unless `(x, y)` is a plausible LV95 point, with x the easting and y
 * the northing. Swapped arguments are the likeliest mistake and would
 * otherwise query the wrong place and return an empty, valid-looking result.
 */
export function assertLv95Point(x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RangeError(`invalid LV95 point (${x}, ${y}): need finite easting and northing`);
  }
  if (isLv95Easting(x) && isLv95Northing(y)) return;
  throw new RangeError(
    `point (${x}, ${y}) is not in LV95 (EPSG:2056)` +
      (looksSwapped(x, y) ? `; ${SWAPPED_HINT}` : ': eastings are ~2.4e6-2.9e6, northings ~1.03e6-1.35e6'),
  );
}

/** Throws unless the box is well-formed and lies in the LV95 range of Switzerland. */
export function assertLv95BBox(b: BBox): void {
  const finite = [b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite);
  if (!finite || b.minX >= b.maxX || b.minY >= b.maxY) {
    throw new RangeError(`invalid bbox ${JSON.stringify(b)}: need finite minX < maxX and minY < maxY`);
  }
  if (!isLv95Easting(b.minX) || !isLv95Easting(b.maxX) || !isLv95Northing(b.minY) || !isLv95Northing(b.maxY)) {
    const swapped = looksSwapped(b.minX, b.minY) && looksSwapped(b.maxX, b.maxY);
    throw new RangeError(
      `bbox ${JSON.stringify(b)} is not in LV95 (EPSG:2056)` +
        (swapped
          ? `; the axes look swapped: minX/maxX are the eastings (~2.4e6-2.9e6), minY/maxY the northings (~1.03e6-1.35e6)`
          : ': eastings are ~2.4e6-2.9e6, northings ~1.03e6-1.35e6'),
    );
  }
}

/** Approximate LV95 → WGS84 (degrees). Internal; error up to about 3 m (see the module comment). */
export function lv95ToWgs84Approx(e: number, n: number): { lon: number; lat: number } {
  const y = (e - 2_600_000) / 1e6;
  const x = (n - 1_200_000) / 1e6;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const lat =
    16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
  return { lon: (lon * 100) / 36, lat: (lat * 100) / 36 };
}

/** Approximate WGS84 (degrees) → LV95. Internal; error up to about 3 m (see the module comment). */
export function wgs84ToLv95Approx(lon: number, lat: number): { e: number; n: number } {
  const p = (lat * 3600 - 169_028.66) / 10_000;
  const l = (lon * 3600 - 26_782.5) / 10_000;
  const e = 2_600_072.37 + 211_455.93 * l - 10_938.51 * l * p - 0.36 * l * p * p - 44.54 * l * l * l;
  const n =
    1_200_147.07 + 308_807.95 * p + 3_745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p * p * p;
  return { e, n };
}

/**
 * Allowance for the formulas' error on top of the caller's padding: the
 * worst measured error is 3.04 m (see the module comment), so 10 m is more
 * than three times that.
 */
export const APPROX_ERROR_ALLOWANCE_METRES = 10;

/**
 * A WGS84 `[west, south, east, north]` box that contains the LV95 box with
 * at least `padMetres` to spare on each side, plus
 * `APPROX_ERROR_ALLOWANCE_METRES` for the error of the approximate formulas.
 */
export function paddedWgs84BBox(b: BBox, padMetres = 50): [number, number, number, number] {
  const pad = padMetres + APPROX_ERROR_ALLOWANCE_METRES;
  const corners = [
    lv95ToWgs84Approx(b.minX - pad, b.minY - pad),
    lv95ToWgs84Approx(b.minX - pad, b.maxY + pad),
    lv95ToWgs84Approx(b.maxX + pad, b.minY - pad),
    lv95ToWgs84Approx(b.maxX + pad, b.maxY + pad),
  ];
  return [
    Math.min(...corners.map((c) => c.lon)),
    Math.min(...corners.map((c) => c.lat)),
    Math.max(...corners.map((c) => c.lon)),
    Math.max(...corners.map((c) => c.lat)),
  ];
}

/** Approximate LV95 extent of a WGS84 `[west, south, east, north]` box. */
export function approxLv95FromWgs84BBox(bb: readonly number[]): BBox {
  const [w, s, e, n] = bb;
  const corners = [wgs84ToLv95Approx(w, s), wgs84ToLv95Approx(w, n), wgs84ToLv95Approx(e, s), wgs84ToLv95Approx(e, n)];
  return {
    minX: Math.min(...corners.map((c) => c.e)),
    minY: Math.min(...corners.map((c) => c.n)),
    maxX: Math.max(...corners.map((c) => c.e)),
    maxY: Math.max(...corners.map((c) => c.n)),
  };
}

export function bboxIntersects(a: BBox, b: BBox): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

function ringArea(ring: Position[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return Math.abs(s) / 2;
}

/** Planar area, outer rings minus holes. */
export function polygonArea(g: PolygonGeometry | MultiPolygonGeometry): number {
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  let a = 0;
  for (const rings of polys) {
    rings.forEach((r, i) => {
      a += i === 0 ? ringArea(r) : -ringArea(r);
    });
  }
  return a;
}

export function geometryBBox(g: Geometry): BBox {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const visit = (c: unknown): void => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      const [x, y] = c as number[];
      b.minX = Math.min(b.minX, x);
      b.minY = Math.min(b.minY, y);
      b.maxX = Math.max(b.maxX, x);
      b.maxY = Math.max(b.maxY, y);
    } else if (Array.isArray(c)) c.forEach(visit);
  };
  visit(g.coordinates);
  return b;
}

/** Sutherland–Hodgman clip of one ring against an axis-aligned box. */
export function clipRingToBBox(ring: Position[], b: BBox): Position[] {
  type Edge = (p: Position) => boolean;
  const edges: Array<[Edge, (p: Position, q: Position) => Position]> = [
    [(p) => p[0] >= b.minX, (p, q) => lerpAtX(p, q, b.minX)],
    [(p) => p[0] <= b.maxX, (p, q) => lerpAtX(p, q, b.maxX)],
    [(p) => p[1] >= b.minY, (p, q) => lerpAtY(p, q, b.minY)],
    [(p) => p[1] <= b.maxY, (p, q) => lerpAtY(p, q, b.maxY)],
  ];
  let out = ring.length > 1 && samePoint(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring.slice();
  for (const [inside, cut] of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(cut(prev, cur));
      }
    }
    if (out.length === 0) return [];
  }
  if (out.length < 3) return [];
  out.push(out[0]);
  return out;
}

function samePoint(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function lerpAtX(p: Position, q: Position, x: number): Position {
  const t = (x - p[0]) / (q[0] - p[0]);
  return [x, p[1] + t * (q[1] - p[1])];
}

function lerpAtY(p: Position, q: Position, y: number): Position {
  const t = (y - p[1]) / (q[1] - p[1]);
  return [p[0] + t * (q[0] - p[0]), y];
}

/** Even-odd containment across all rings (holes included); boundary points are not reliably classified (`geometryIntersectsPolygon` adds an explicit boundary test). */
function pointInRings(x: number, y: number, rings: Position[][]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function pointOnRings(p: Position, rings: Position[][]): boolean {
  for (const ring of rings) {
    for (let j = 1; j < ring.length; j++) {
      if (orient(ring[j - 1], ring[j], p) === 0 && onSegment(ring[j - 1], ring[j], p)) return true;
    }
  }
  return false;
}

function orient(a: Position, b: Position, c: Position): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function onSegment(a: Position, b: Position, p: Position): boolean {
  return (
    p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) &&
    p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1])
  );
}

/** Closed segments `ab` and `cd` share a point (touching counts). */
function segmentsIntersect(a: Position, b: Position, c: Position, d: Position): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d)) ||
    (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b));
}

function pathCrossesRings(path: Position[], rings: Position[][]): boolean {
  for (let i = 1; i < path.length; i++) {
    for (const ring of rings) {
      for (let j = 1; j < ring.length; j++) {
        if (segmentsIntersect(path[i - 1], path[i], ring[j - 1], ring[j])) return true;
      }
    }
  }
  return false;
}

/**
 * Whether a feature geometry intersects a polygon (touching counts, as in
 * the service's tolerance-0 `identify`). Used to clip results client-side
 * when a polygon was too long to send and its bounding box was queried.
 */
export function geometryIntersectsPolygon(g: Geometry, poly: PolygonGeometry): boolean {
  const gb = geometryBBox(g);
  const pb = geometryBBox(poly);
  if (gb.maxX < pb.minX || gb.minX > pb.maxX || gb.maxY < pb.minY || gb.minY > pb.maxY) return false;
  const rings = poly.coordinates;
  const pointIn = (p: Position): boolean => pointInRings(p[0], p[1], rings) || pointOnRings(p, rings);
  const lineHits = (line: Position[]): boolean => line.some(pointIn) || pathCrossesRings(line, rings);
  const polygonHits = (fr: Position[][]): boolean =>
    fr.some((r) => r.some(pointIn) || pathCrossesRings(r, rings)) || pointInRings(rings[0][0][0], rings[0][0][1], fr);
  switch (g.type) {
    case 'Point':
      return pointIn(g.coordinates);
    case 'MultiPoint':
      return g.coordinates.some(pointIn);
    case 'LineString':
      return lineHits(g.coordinates);
    case 'MultiLineString':
      return g.coordinates.some(lineHits);
    case 'Polygon':
      return polygonHits(g.coordinates);
    case 'MultiPolygon':
      return g.coordinates.some(polygonHits);
  }
}
