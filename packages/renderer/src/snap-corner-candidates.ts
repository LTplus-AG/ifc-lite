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

/** Edges one `step` of a `CandidateBuild` processes: the most a slice can overshoot its budget by. */
export const CANDIDATE_CHUNK = 256;

/**
 * Resumable build of one piece's candidates: `step` handles up to `maxEdges`
 * edges and reports whether the piece is finished, so an idle slice can stop
 * inside a very large piece and the next slice continues from the cursor.
 */
export class CandidateBuild {
  private readonly seen = new Set<string>();
  private readonly corners: number[] = [];
  private readonly edges: Float64Array;
  private next = 0;
  get done(): boolean { return this.next >= this.cache.edges.length; }

  constructor(private readonly expressId: number, private readonly cache: MeshGeometryCache) {
    this.edges = new Float64Array(cache.edges.length * 6);
  }

  private addCorner(p: Vec3, valence: number): void {
    if (valence < MIN_CORNER_VALENCE) return;
    const key = `${Math.round(p.x * QUANT)},${Math.round(p.y * QUANT)},${Math.round(p.z * QUANT)}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.corners.push(p.x, p.y, p.z);
  }

  /** Process up to `maxEdges` more edges; true once every edge is done. */
  step(maxEdges: number = CANDIDATE_CHUNK): boolean {
    const all = this.cache.edges;
    const end = Math.min(all.length, this.next + maxEdges);
    for (; this.next < end; this.next++) {
      const edge = all[this.next];
      this.edges.set([edge.v0.x, edge.v0.y, edge.v0.z, edge.v1.x, edge.v1.y, edge.v1.z], this.next * 6);
      this.addCorner(edge.v0, edge.v0Valence);
      this.addCorner(edge.v1, edge.v1Valence);
      for (const j of edge.junctions) this.addCorner(j.point, j.valence);
    }
    return this.done;
  }

  /** The finished candidates; only valid once `step` returned true. */
  result(): PieceCandidates {
    return { expressId: this.expressId, corners: Float64Array.from(this.corners), edges: this.edges };
  }
}

/** Feature corners and feature edges of a geometry cache as flat world-space arrays. */
export function candidatesFromCache(expressId: number, cache: MeshGeometryCache): PieceCandidates {
  const build = new CandidateBuild(expressId, cache);
  while (!build.step(Infinity)) { /* one step finishes it */ }
  return build.result();
}
