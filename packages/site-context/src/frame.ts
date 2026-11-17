/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Site extent, terrain resolution and the coverage check. */

import type { BBox } from '@ifc-lite/geodata-ch';
import type { MapPoint } from './types.js';

/** Largest radius accepted, in metres. A bigger site is a regional model, not site context. */
export const MAX_RADIUS = 5000;
/** Largest terrain grid accepted, in nodes. 'auto' stays near 251 001. */
export const MAX_TERRAIN_NODES = 4_000_000;

/**
 * The swissALTI3D / cadastral provider's coverage, as an LV95 envelope of
 * Switzerland and Liechtenstein. It is the same envelope
 * `@ifc-lite/geodata-ch` validates against; a centre outside it is refused
 * before any request is sent.
 */
export const LV95_COVERAGE: BBox = { minX: 2_420_000, minY: 1_030_000, maxX: 2_900_000, maxY: 1_350_000 };

/** The centre is outside the provider's coverage. Nothing was fetched or built. */
export class SiteContextCoverageError extends Error {
  constructor(
    readonly centre: MapPoint,
    reason: string,
  ) {
    super(`site centre (${centre.x}, ${centre.y}) is outside the Swiss geodata coverage: ${reason}`);
    this.name = 'SiteContextCoverageError';
  }
}

export function assertInCoverage(centre: MapPoint): void {
  const { x, y } = centre;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RangeError(`site centre must be finite EPSG:2056 coordinates, got (${x}, ${y})`);
  }
  const c = LV95_COVERAGE;
  if (x >= c.minX && x <= c.maxX && y >= c.minY && y <= c.maxY) return;
  const swapped = y >= c.minX && y <= c.maxX && x >= c.minY && x <= c.maxY;
  throw new SiteContextCoverageError(
    centre,
    swapped
      ? 'the coordinates look swapped (easting ~2.4e6-2.9e6 first, northing ~1.03e6-1.35e6 second)'
      : 'EPSG:2056 eastings run ~2.42e6-2.9e6 and northings ~1.03e6-1.35e6',
  );
}

/** Auto resolutions are rounded up to this step so every node coordinate is exact in float32 and f64. */
export const AUTO_RESOLUTION_STEP = 1 / 16;

/**
 * `max(0.5, extent / 500)` metres, rounded up to a multiple of 1/16 m. This
 * keeps the terrain near 501 × 501 nodes (about 250 000 vertices and 500 000
 * triangles): 200 m → 0.5 m, 500 m → 1 m, 1 km → 2 m. The rounding makes
 * node coordinates multiples of 1/16 m, which float32 represents exactly
 * within a chunk, so the edge vertices chunks share are bit-identical.
 */
export function autoResolution(extent: number): number {
  const raw = Math.max(0.5, extent / 500);
  return Math.ceil(raw / AUTO_RESOLUTION_STEP - 1e-9) * AUTO_RESOLUTION_STEP;
}

export function resolveResolution(extent: number, resolution: number | 'auto' | undefined): number {
  if (resolution === undefined || resolution === 'auto') return autoResolution(extent);
  if (!(resolution > 0) || !Number.isFinite(resolution)) {
    throw new RangeError(`resolution must be a positive number of metres or 'auto', got ${resolution}`);
  }
  return resolution;
}

export function assertRadius(radius: number): void {
  if (!(radius > 0) || !Number.isFinite(radius) || radius > MAX_RADIUS) {
    throw new RangeError(`radius must be a number of metres in (0, ${MAX_RADIUS}], got ${radius}`);
  }
}

/**
 * The terrain box: centre ± radius, widened outwards to whole multiples of
 * the resolution so grid nodes sit on one lattice for every centre.
 */
export function siteBBox(centre: MapPoint, radius: number, resolution: number): BBox {
  return {
    minX: Math.floor((centre.x - radius) / resolution + 1e-9) * resolution,
    minY: Math.floor((centre.y - radius) / resolution + 1e-9) * resolution,
    maxX: Math.ceil((centre.x + radius) / resolution - 1e-9) * resolution,
    maxY: Math.ceil((centre.y + radius) / resolution - 1e-9) * resolution,
  };
}

export function gridNodeCount(b: BBox, resolution: number): number {
  const w = Math.floor((b.maxX - b.minX) / resolution + 1e-9) + 1;
  const h = Math.floor((b.maxY - b.minY) / resolution + 1e-9) + 1;
  return w * h;
}

/** The document origin's plan position: the centre rounded to whole metres. */
export function planOrigin(centre: MapPoint): [number, number] {
  return [Math.round(centre.x), Math.round(centre.y)];
}
