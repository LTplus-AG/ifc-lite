/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A parcel boundary as a ribbon draped on the terrain: every ring densified
 * about every metre, offset half the ribbon width to each side, and each side
 * vertex set `DRAPE_OFFSET` above the bilinear terrain height under it. A
 * vertex over missing terrain is not given a height; the ribbon breaks there.
 */

import type { MultiPolygonGeometry, PolygonGeometry } from '@ifc-lite/geodata-ch';
import { sampleTerrain, type TerrainGrid } from './terrain-mesh.js';
import type { SiteContextMesh } from './types.js';

export const DENSIFY_STEP = 1;
export const DRAPE_OFFSET = 0.1;
export const RIBBON_WIDTH = 0.3;

export interface ParcelRibbon {
  mesh: SiteContextMesh | null;
  /** Boundary vertices after densification. */
  points: number;
  /** Of those, the ones without terrain under a ribbon edge. */
  undraped: number;
}

type Pt = [number, number];

/** Ring vertices densified to at most `step` apart; the closing duplicate is dropped. */
export function densifyRing(ring: number[][], step = DENSIFY_STEP): Pt[] {
  const pts: Pt[] = ring.map((p) => [p[0], p[1]]);
  if (pts.length > 1) {
    const [a, b] = [pts[0], pts[pts.length - 1]];
    if (a[0] === b[0] && a[1] === b[1]) pts.pop();
  }
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / step - 1e-9));
    for (let k = 0; k < n; k++) out.push([p[0] + ((q[0] - p[0]) * k) / n, p[1] + ((q[1] - p[1]) * k) / n]);
  }
  return out;
}

function leftNormal(p: Pt, q: Pt): Pt {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len = Math.hypot(dx, dy) || 1;
  return [-dy / len, dx / len];
}

export function parcelRings(geometry: PolygonGeometry | MultiPolygonGeometry): number[][][] {
  return geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
}

/** Centre of the geometry's bounding box. */
export function parcelCentre(geometry: PolygonGeometry | MultiPolygonGeometry): Pt {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of parcelRings(geometry)) {
    for (const p of ring) {
      minX = Math.min(minX, p[0]);
      maxX = Math.max(maxX, p[0]);
      minY = Math.min(minY, p[1]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

export function buildParcelRibbon(
  geometry: PolygonGeometry | MultiPolygonGeometry,
  grid: TerrainGrid,
  origin: [number, number, number],
): ParcelRibbon {
  const half = RIBBON_WIDTH / 2;
  const pos: number[] = [];
  const idx: number[] = [];
  let points = 0;
  let undraped = 0;
  for (const ring of parcelRings(geometry)) {
    const pts = densifyRing(ring);
    const n = pts.length;
    if (n < 3) continue;
    points += n;
    // Vertex pair index per point (left, right), or -1 where undraped.
    const pair = new Int32Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const n1 = leftNormal(pts[(i - 1 + n) % n], p);
      const n2 = leftNormal(p, pts[(i + 1) % n]);
      let mx = n1[0] + n2[0];
      let my = n1[1] + n2[1];
      const ml = Math.hypot(mx, my);
      if (ml < 1e-9) [mx, my] = n2;
      else [mx, my] = [mx / ml, my / ml];
      // Miter, limited so a sharp corner does not shoot out.
      const len = half / Math.max(mx * n2[0] + my * n2[1], 0.25);
      const lx = p[0] + mx * len;
      const ly = p[1] + my * len;
      const rx = p[0] - mx * len;
      const ry = p[1] - my * len;
      const hl = sampleTerrain(grid, lx, ly);
      const hr = sampleTerrain(grid, rx, ry);
      if (!Number.isFinite(hl) || !Number.isFinite(hr)) {
        undraped++;
        continue;
      }
      pair[i] = pos.length / 3;
      pos.push(lx - origin[0], ly - origin[1], hl + DRAPE_OFFSET - origin[2]);
      pos.push(rx - origin[0], ry - origin[1], hr + DRAPE_OFFSET - origin[2]);
    }
    for (let i = 0; i < n; i++) {
      const a = pair[i];
      const b = pair[(i + 1) % n];
      if (a < 0 || b < 0) continue;
      // a: left, a+1: right. Counter-clockwise seen from above.
      idx.push(a + 1, b + 1, b, a + 1, b, a);
    }
  }
  if (idx.length === 0) return { mesh: null, points, undraped };
  const positions = Float32Array.from(pos);
  const normals = new Float32Array(positions.length);
  for (let i = 2; i < normals.length; i += 3) normals[i] = 1;
  return { mesh: { positions, normals, indices: Uint32Array.from(idx) }, points, undraped };
}
