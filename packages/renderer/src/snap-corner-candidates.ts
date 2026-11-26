/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-piece snap candidates (feature corners and feature edges, world space)
 * as flat typed arrays, built once from the snap geometry cache (#11504).
 */

import type { Vec3 } from './raycaster.js';
import { MIN_CORNER_VALENCE } from './snap-edge-runs.js';
import type { MeshGeometryCache } from './snap-geometry-cache.js';

export interface PieceCandidates {
  expressId: number;
  /** x, y, z per corner. */
  corners: Float64Array;
  /** x0, y0, z0, x1, y1, z1 per edge. */
  edges: Float64Array;
}

/** Corner quantisation used to drop duplicates within a piece (0.1 mm). */
const QUANT = 1e4;

/** Feature corners and feature edges of a geometry cache as flat world-space arrays. */
export function candidatesFromCache(expressId: number, cache: MeshGeometryCache): PieceCandidates {
  const seen = new Set<string>();
  const corners: number[] = [];
  const addCorner = (p: Vec3, valence: number) => {
    if (valence < MIN_CORNER_VALENCE) return;
    const key = `${Math.round(p.x * QUANT)},${Math.round(p.y * QUANT)},${Math.round(p.z * QUANT)}`;
    if (seen.has(key)) return;
    seen.add(key);
    corners.push(p.x, p.y, p.z);
  };
  const edges = new Float64Array(cache.edges.length * 6);
  cache.edges.forEach((edge, i) => {
    edges.set([edge.v0.x, edge.v0.y, edge.v0.z, edge.v1.x, edge.v1.y, edge.v1.z], i * 6);
    addCorner(edge.v0, edge.v0Valence);
    addCorner(edge.v1, edge.v1Valence);
    for (const j of edge.junctions) addCorner(j.point, j.valence);
  });
  return { expressId, corners: Float64Array.from(corners), edges };
}
