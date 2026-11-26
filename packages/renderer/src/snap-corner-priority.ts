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
import type { Camera } from './camera.js';

/** A piece with more triangles than this is built after the others: its snap cache is one uninterruptible step. */
export const BIG_PIECE_TRIANGLES = 20_000;

const boundsOf = new WeakMap<MeshData, Float64Array>();

/** World AABB (minX, minY, minZ, maxX, maxY, maxZ); `origin` is the piece's f64 frame offset. */
function pieceBounds(piece: MeshData): Float64Array {
  let b = boundsOf.get(piece);
  if (b) return b;
  const p = piece.positions, o = piece.origin;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i + 2 < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  b = new Float64Array(6);
  if (x0 > x1) b.fill(0);
  else b.set([x0 + (o?.[0] ?? 0), y0 + (o?.[1] ?? 0), z0 + (o?.[2] ?? 0), x1 + (o?.[0] ?? 0), y1 + (o?.[1] ?? 0), z1 + (o?.[2] ?? 0)]);
  boundsOf.set(piece, b);
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
  private next = 0;
  private sorted: MeshData[] | null = null;
  private readonly eye: Vec3;

  constructor(
    private readonly pieces: readonly MeshData[],
    private readonly camera: Pick<Camera, 'projectToScreen' | 'getPosition'>,
    private readonly viewport: { width: number; height: number },
  ) {
    this.dist = new Float64Array(pieces.length);
    this.onScreen = new Uint8Array(pieces.length);
    this.big = new Uint8Array(pieces.length);
    this.eye = camera.getPosition();
  }

  get done(): boolean { return this.sorted !== null; }

  step(over: () => boolean): void {
    const { pieces, dist, onScreen, big, eye } = this;
    const inView = (p: Vec3) => {
      const s = this.camera.projectToScreen(p, this.viewport.width, this.viewport.height);
      return !!s && s.x >= 0 && s.y >= 0 && s.x <= this.viewport.width && s.y <= this.viewport.height;
    };
    while (this.next < pieces.length) {
      const i = this.next++;
      const b = pieceBounds(pieces[i]);
      const cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, cz = (b[2] + b[5]) / 2;
      dist[i] = (cx - eye.x) ** 2 + (cy - eye.y) ** 2 + (cz - eye.z) ** 2;
      let on = inView({ x: cx, y: cy, z: cz });
      for (let k = 0; k < 8 && !on; k++) on = inView({ x: b[k & 1 ? 3 : 0], y: b[k & 2 ? 4 : 1], z: b[k & 4 ? 5 : 2] });
      onScreen[i] = on ? 1 : 0;
      big[i] = pieces[i].indices.length / 3 > BIG_PIECE_TRIANGLES ? 1 : 0;
      if (over()) return;
    }
    const idx = Array.from({ length: pieces.length }, (_, i) => i);
    idx.sort((a, c) => onScreen[c] - onScreen[a] || big[a] - big[c] || dist[a] - dist[c] || a - c);
    this.sorted = idx.map((i) => pieces[i]);
  }

  result(): MeshData[] { return this.sorted ?? []; }
}
