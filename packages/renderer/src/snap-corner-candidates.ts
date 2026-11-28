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

/** Work units one `step` of a `CandidateBuild` processes: the most a slice can overshoot its budget by. */
export const CANDIDATE_CHUNK = 256;

/**
 * Resumable build of one piece's candidates: `step` handles edge headers, junctions and corner-buffer writes in bounded batches and reports whether the piece is finished, so an idle slice can stop
 * inside a very large piece and the next slice continues from the cursor.
 */
export class CandidateBuild {
  private readonly seen = new Set<string>();
  private readonly corners: number[] = [];
  private readonly edges: Float64Array;
  private readonly work = this.build();
  private finished: PieceCandidates | null = null;
  get done(): boolean { return this.finished !== null; }

  constructor(private readonly expressId: number, private readonly cache: MeshGeometryCache) {
    this.edges = new Float64Array(cache.edges.length * 6);
  }

  private addCorner(p: Vec3, valence: number): void {
    if (valence < MIN_CORNER_VALENCE) return;
    // Edge endpoints and junctions already use welded positions. Only collapse exact repeats.
    const key = `${p.x},${p.y},${p.z}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.corners.push(p.x, p.y, p.z);
  }

  step(budget: number = CANDIDATE_CHUNK): boolean {
    for (let i = 0; i < budget && !this.done; i++) this.work.next();
    return this.done;
  }

  private *build(): Generator<void> {
    let offset = 0;
    for (const edge of this.cache.edges) {
      this.edges[offset] = edge.v0.x;
      this.edges[offset + 1] = edge.v0.y;
      this.edges[offset + 2] = edge.v0.z;
      this.edges[offset + 3] = edge.v1.x;
      this.edges[offset + 4] = edge.v1.y;
      this.edges[offset + 5] = edge.v1.z;
      this.addCorner(edge.v0, edge.v0Valence);
      this.addCorner(edge.v1, edge.v1Valence);
      offset += 6;
      yield;
      for (const junction of edge.junctions) {
        this.addCorner(junction.point, junction.valence);
        yield;
      }
    }
    const packed = new Float64Array(this.corners.length);
    for (let i = 0; i < packed.length; i += 3) {
      packed[i] = this.corners[i];
      packed[i + 1] = this.corners[i + 1];
      packed[i + 2] = this.corners[i + 2];
      yield;
    }
    this.finished = { expressId: this.expressId, corners: packed, edges: this.edges };
  }

  /** The finished candidates; only valid once `step` returned true. */
  result(): PieceCandidates {
    if (!this.finished) throw new Error('Snap candidates are still building');
    return this.finished;
  }
}

/** Feature corners and feature edges of a geometry cache as flat world-space arrays. */
export function candidatesFromCache(expressId: number, cache: MeshGeometryCache): PieceCandidates {
  const build = new CandidateBuild(expressId, cache);
  while (!build.step(Infinity)) { /* one step finishes it */ }
  return build.result();
}
