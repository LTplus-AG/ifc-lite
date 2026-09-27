/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Grid helpers for the snap engine:
 * - the drawn construction grid (nearest node, the lowest snap tier), and
 * - a uniform spatial hash that sources use to answer "what is within r of
 *   the cursor" without scanning every target on every pointer move.
 */

import type { Vec2 } from './types.js';

export interface GridSpec {
  /** A grid node, workplane-local. */
  origin: Vec2;
  /** Node spacing, metres (> 0). */
  spacing: number;
}

/** Nearest grid node to `p`, or null for a degenerate spacing. */
export function nearestGridNode(p: Vec2, g: GridSpec): Vec2 | null {
  const s = g.spacing;
  if (!(s > 0) || !Number.isFinite(s)) return null;
  return [
    g.origin[0] + Math.round((p[0] - g.origin[0]) / s) * s,
    g.origin[1] + Math.round((p[1] - g.origin[1]) / s) * s,
  ];
}

/**
 * Uniform grid over 2D points. Cell size should be about the typical query
 * radius; a query visits the (2k+1)² cells covering its box, so cost follows
 * the local density, not the total count.
 */
export class UniformGridIndex<T> {
  private readonly cells = new Map<string, { p: Vec2; item: T }[]>();
  private readonly cell: number;
  private count = 0;

  constructor(cellSize: number) {
    if (!(cellSize > 0) || !Number.isFinite(cellSize)) {
      throw new RangeError(`UniformGridIndex cell size must be a positive finite number, got ${cellSize}`);
    }
    this.cell = cellSize;
  }

  get size(): number {
    return this.count;
  }

  private key(ix: number, iy: number): string {
    return `${ix},${iy}`;
  }

  insert(p: Vec2, item: T): void {
    const k = this.key(Math.floor(p[0] / this.cell), Math.floor(p[1] / this.cell));
    let bucket = this.cells.get(k);
    if (!bucket) {
      bucket = [];
      this.cells.set(k, bucket);
    }
    bucket.push({ p, item });
    this.count++;
  }

  clear(): void {
    this.cells.clear();
    this.count = 0;
  }

  /** Visit every item within `radius` (inclusive) of `center`, in insertion order per cell. */
  query(center: Vec2, radius: number, visit: (item: T, p: Vec2, d: number) => void): void {
    if (!(radius >= 0)) return;
    const x0 = Math.floor((center[0] - radius) / this.cell);
    const x1 = Math.floor((center[0] + radius) / this.cell);
    const y0 = Math.floor((center[1] - radius) / this.cell);
    const y1 = Math.floor((center[1] + radius) / this.cell);
    // A huge radius relative to the cell would enumerate empty cells, and a cell
    // index beyond 2^53 (or a non-finite centre) would never advance: scan the buckets.
    const safe = Number.isSafeInteger(x0) && Number.isSafeInteger(x1) && Number.isSafeInteger(y0) && Number.isSafeInteger(y1);
    if (!safe || (x1 - x0 + 1) * (y1 - y0 + 1) > this.cells.size) {
      for (const bucket of this.cells.values()) this.visitBucket(bucket, center, radius, visit);
      return;
    }
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const bucket = this.cells.get(this.key(ix, iy));
        if (bucket) this.visitBucket(bucket, center, radius, visit);
      }
    }
  }

  private visitBucket(
    bucket: readonly { p: Vec2; item: T }[],
    center: Vec2,
    radius: number,
    visit: (item: T, p: Vec2, d: number) => void,
  ): void {
    for (const e of bucket) {
      const d = Math.hypot(e.p[0] - center[0], e.p[1] - center[1]);
      if (d <= radius) visit(e.item, e.p, d);
    }
  }
}
