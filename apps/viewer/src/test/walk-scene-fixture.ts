/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A tiny in-memory scene for the walk tests: boxes and tessellated slabs as
 * entities with `MeshData`-shaped pieces, behind a {@link WalkGeometrySource}.
 */

import type { WalkBounds, WalkGeometrySource, WalkPiece } from '@/components/viewer/walk/walkCollisionWorld.js';

interface TestEntity {
  pieces: WalkPiece[];
  bounds: WalkBounds;
}

export class TestScene implements WalkGeometrySource {
  private readonly entities = new Map<number, TestEntity>();
  private nextId = 1;
  /** Ids whose geometry is "not resident" (cold-evicted). */
  readonly nonResident = new Set<number>();

  /** An axis-aligned box as 12 triangles. Returns the entity id. */
  box(min: [number, number, number], max: [number, number, number], ifcType = 'IfcWall', origin?: [number, number, number]): number {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const o = origin ?? [0, 0, 0];
    const corners = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ].map(([x, y, z]) => [x - o[0], y - o[1], z - o[2]]);
    const faces = [
      [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4],
      [3, 6, 2], [3, 7, 6], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
    ];
    return this.add({
      positions: new Float32Array(corners.flat()),
      indices: new Uint32Array(faces.flat()),
      origin: origin ? [...origin] : undefined,
      ifcType,
    });
  }

  /** A flat slab top at height `y`, tessellated into `n * n` quads (exercises the triangle tree). */
  grid(x0: number, z0: number, size: number, y: number, n: number, ifcType = 'IfcSlab', origin?: [number, number, number]): number {
    const o = origin ?? [0, 0, 0];
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        positions.push(x0 + (size * i) / n - o[0], y - o[1], z0 + (size * j) / n - o[2]);
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = i * (n + 1) + j, b = a + 1, c = a + n + 1, d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    return this.add({ positions: new Float32Array(positions), indices: new Uint32Array(indices), origin: origin ? [...origin] : undefined, ifcType });
  }

  /** A planar quad (two triangles) through four corners, in order. */
  quad(corners: [number, number, number][], ifcType: string): number {
    return this.add({ positions: new Float32Array(corners.flat()), indices: new Uint32Array([0, 1, 2, 0, 2, 3]), ifcType });
  }

  /** A straight flight of `count` solid steps rising along +Z from (x0, y0, z0). */
  stairs(x0: number, y0: number, z0: number, width: number, count: number, rise: number, going: number): number[] {
    const ids: number[] = [];
    for (let i = 0; i < count; i++) {
      ids.push(this.box([x0, y0, z0 + i * going], [x0 + width, y0 + (i + 1) * rise, z0 + (i + 1) * going], 'IfcStairFlight'));
    }
    return ids;
  }

  private add(piece: WalkPiece): number {
    const id = this.nextId++;
    const p = piece.positions;
    const o = piece.origin ?? [0, 0, 0];
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      minX = Math.min(minX, p[i] + o[0]); maxX = Math.max(maxX, p[i] + o[0]);
      minY = Math.min(minY, p[i + 1] + o[1]); maxY = Math.max(maxY, p[i + 1] + o[1]);
      minZ = Math.min(minZ, p[i + 2] + o[2]); maxZ = Math.max(maxZ, p[i + 2] + o[2]);
    }
    this.entities.set(id, { pieces: [piece], bounds: { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } } });
    return id;
  }

  entityIds(): Iterable<number> {
    return this.entities.keys();
  }

  bounds(id: number): WalkBounds | null {
    return this.entities.get(id)?.bounds ?? null;
  }

  pieces(id: number): readonly WalkPiece[] | undefined {
    if (this.nonResident.has(id)) return undefined;
    return this.entities.get(id)?.pieces;
  }
}
