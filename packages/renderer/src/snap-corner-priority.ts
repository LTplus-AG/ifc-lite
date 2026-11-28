/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which pieces' candidates to build first (#11504): pieces whose bounds reach
 * the viewport, nearest the camera first, then the rest the same way. Bounds
 * are computed once per piece, resumably, so an idle slice can stop anywhere.
 */

import type { MeshData } from '@ifc-lite/geometry';
import type { Vec3 } from './raycaster.js';
import { ChunkedSort } from './snap-chunked-sort.js';
import type { Camera } from './camera.js';
import { edgeProjector } from './snap-project-edge.js';

/** A piece with more triangles than this is built after the others: its snap cache is one uninterruptible step. */
export const BIG_PIECE_TRIANGLES = 20_000;

const boundsOf = new WeakMap<object, Float64Array>();

/** World AABB (minX, minY, minZ, maxX, maxY, maxZ); `origin` is the piece's f64 frame offset. */
export function* pieceBounds(piece: MeshData, cacheKey: object = piece): Generator<void, Float64Array> {
  let b = boundsOf.get(cacheKey);
  if (b) return b;
  const p = piece.positions, o = piece.origin;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i + 2 < p.length; i += 3) {
    if (i > 0 && i % 3072 === 0) yield;
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  b = new Float64Array(6);
  if (x0 > x1) b.fill(0);
  else b.set([x0 + (o?.[0] ?? 0), y0 + (o?.[1] ?? 0), z0 + (o?.[2] ?? 0), x1 + (o?.[0] ?? 0), y1 + (o?.[1] ?? 0), z1 + (o?.[2] ?? 0)]);
  boundsOf.set(cacheKey, b);
  return b;
}

/**
 * Orders `pieces` on-screen first, then small before big pieces, then by distance from the camera, in steps
 * that stop when `over()` says so: bounds and screen tests for 10k+ pieces
 * must not hold up a frame. `done` is true once `result()` may be read.
 */
export class PriorityOrder {
  private readonly dist: Float64Array;
  private readonly onScreen: Uint8Array;
  private readonly big: Uint8Array;
  private readonly work = this.build();
  private sorted: MeshData[] | null = null;
  private readonly eye: Vec3;

  constructor(
    private readonly pieces: readonly MeshData[],
    private readonly camera: Pick<Camera, 'projectToScreen' | 'getPosition'>,
    private readonly viewport: { width: number; height: number },
    private readonly occurrences: readonly MeshData[] = [],
    private readonly occurrenceBounds?: ReadonlyMap<MeshData, Float64Array>,
  ) {
    const count = pieces.length + occurrences.length;
    this.dist = new Float64Array(count);
    this.onScreen = new Uint8Array(count);
    this.big = new Uint8Array(count);
    this.eye = camera.getPosition();
  }

  get done(): boolean { return this.sorted !== null; }

  step(over: () => boolean): void {
    do { this.work.next(); } while (!this.done && !over());
  }

  private *build(): Generator<void> {
    const { pieces, dist, onScreen, big, eye } = this;
    const { width, height } = this.viewport;
    const projectEdge = edgeProjector(this.camera, width, height);
    // The projected footprint can cross the viewport without any corner inside it.
    // Its screen bounds need at most twelve depth-clipped edges, independent of mesh size.
    const reachesView = (box: Float64Array, center: Vec3) => {
      const middle = this.camera.projectToScreen(center, width, height);
      if (middle && middle.x >= 0 && middle.x <= width && middle.y >= 0 && middle.y <= height) return true;
      const corners = Array.from({ length: 8 }, (_, k) => ({
        x: box[k & 1 ? 3 : 0], y: box[k & 2 ? 4 : 1], z: box[k & 4 ? 5 : 2],
      }));
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      const include = (point: { x: number; y: number }) => {
        left = Math.min(left, point.x); right = Math.max(right, point.x);
        top = Math.min(top, point.y); bottom = Math.max(bottom, point.y);
        return left <= width && right >= 0 && top <= height && bottom >= 0;
      };
      let clippedMask = 0;
      for (let k = 0; k < corners.length; k++) {
        const point = this.camera.projectToScreen(corners[k], width, height);
        if (!point) clippedMask |= 1 << k;
        else if (include(point)) return true;
      }
      if (!clippedMask) return false;
      // A depth-clipped box can acquire new extrema at the near or far plane.
      for (let k = 0; k < corners.length; k++) {
        for (const axis of [1, 2, 4]) {
          const other = k | axis;
          if (other === k || !(clippedMask & ((1 << k) | (1 << other)))) continue;
          const edge = projectEdge(corners[k], corners[other]);
          if (edge && (include(edge.sa) || include(edge.sb))) return true;
        }
      }
      return false;
    };
    const pieceAt = (i: number) => i < pieces.length ? pieces[i] : this.occurrences[i - pieces.length];
    const idx = new Int32Array(dist.length);
    for (let i = 0; i < idx.length; i++) {
      idx[i] = i;
      const piece = pieceAt(i);
      const b = this.occurrenceBounds?.get(piece) ?? (yield* pieceBounds(piece));
      const cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, cz = (b[2] + b[5]) / 2;
      dist[i] = (cx - eye.x) ** 2 + (cy - eye.y) ** 2 + (cz - eye.z) ** 2;
      onScreen[i] = reachesView(b, { x: cx, y: cy, z: cz }) ? 1 : 0;
      big[i] = piece.indices.length / 3 > BIG_PIECE_TRIANGLES ? 1 : 0;
      yield;
    }
    const sorter = new ChunkedSort(idx, (a, c) => onScreen[c] - onScreen[a] || big[a] - big[c] || dist[a] - dist[c] || a - c);
    while (!sorter.step()) yield;
    const ordered: MeshData[] = [];
    for (const i of sorter.result()) {
      ordered.push(pieceAt(i));
      if (ordered.length % 1024 === 0) yield;
    }
    this.sorted = ordered;
  }

  result(): MeshData[] { return this.sorted ?? []; }
}
