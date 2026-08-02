/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  simplifyIndicesByClustering,
  lodCellSizeForBounds,
  LOD_MIN_TRIANGLES,
  LOD_CELL_FRACTION,
} from './lod-simplify.ts';

const STRIDE = 7; // batch layout: pos3 + normal3 + entityId lane

/** Build interleaved vertex data from positions (normals zeroed). The
 *  optional per-vertex entity lane mirrors the batch layout's u32 at
 *  float offset 6. */
function interleave(
  positions: Array<[number, number, number]>,
  entityOf?: (vertexIndex: number) => number,
): Float32Array {
  const out = new Float32Array(positions.length * STRIDE);
  const ids = new Uint32Array(out.buffer);
  positions.forEach(([x, y, z], i) => {
    out[i * STRIDE] = x;
    out[i * STRIDE + 1] = y;
    out[i * STRIDE + 2] = z;
    if (entityOf) ids[i * STRIDE + 6] = entityOf(i);
  });
  return out;
}

/**
 * A dense triangle strip along X: `n` triangles whose vertices advance by
 * `step`. With a cell size much larger than `step`, neighbouring triangles
 * collapse; with a tiny cell size they all survive.
 */
function strip(n: number, step: number) {
  const positions: Array<[number, number, number]> = [];
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const base = positions.length;
    positions.push([x, 0, 0], [x + step, 0, 0], [x, 1000, 0]);
    indices.push(base, base + 1, base + 2);
  }
  return { vertexData: interleave(positions), indices: new Uint32Array(indices) };
}

describe('simplifyIndicesByClustering', () => {
  it('drops triangles whose corners collapse into one cell and reduces index count', () => {
    const { vertexData, indices } = strip(LOD_MIN_TRIANGLES, 0.01);
    // Cell of 1.0 swallows ~100 strip steps: x-extent corners collapse.
    const lod = simplifyIndicesByClustering(vertexData, STRIDE, indices, 1.0);
    assert.ok(lod, 'simplification should pay on a dense strip');
    assert.ok(lod!.length < indices.length * 0.25, `expected big reduction, got ${lod!.length}/${indices.length}`);
    assert.strictEqual(lod!.length % 3, 0);
    // Every output index refers to a real vertex.
    for (const idx of lod!) assert.ok(idx < vertexData.length / STRIDE);
  });

  it('returns null when nothing collapses (result not meaningfully smaller)', () => {
    const { vertexData, indices } = strip(LOD_MIN_TRIANGLES, 10);
    assert.strictEqual(simplifyIndicesByClustering(vertexData, STRIDE, indices, 0.001), null);
  });

  it('returns null below the triangle floor', () => {
    const { vertexData, indices } = strip(LOD_MIN_TRIANGLES - 1, 0.01);
    assert.strictEqual(simplifyIndicesByClustering(vertexData, STRIDE, indices, 1.0), null);
  });

  it('returns null for a non-positive or non-finite cell size', () => {
    const { vertexData, indices } = strip(LOD_MIN_TRIANGLES, 0.01);
    assert.strictEqual(simplifyIndicesByClustering(vertexData, STRIDE, indices, 0), null);
    assert.strictEqual(simplifyIndicesByClustering(vertexData, STRIDE, indices, NaN), null);
  });

  it('returns null when everything collapses to nothing (degenerate blob)', () => {
    // All vertices in one spot: every triangle collapses.
    const positions: Array<[number, number, number]> = [];
    const indices: number[] = [];
    for (let i = 0; i < LOD_MIN_TRIANGLES; i++) {
      const base = positions.length;
      positions.push([0, 0, 0], [0.001, 0, 0], [0, 0.001, 0]);
      indices.push(base, base + 1, base + 2);
    }
    const lod = simplifyIndicesByClustering(interleave(positions), STRIDE, new Uint32Array(indices), 10);
    assert.strictEqual(lod, null);
  });

  it('never merges co-located vertices from DIFFERENT entities (entity-scoped clustering)', () => {
    // Two dense strips occupying the SAME positions, tagged with different
    // per-vertex entity ids. Cross-entity welding would let one entity's
    // vertex represent the other's cell — every output triangle must keep
    // its representatives within one entity.
    const positions: Array<[number, number, number]> = [];
    const indices: number[] = [];
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < LOD_MIN_TRIANGLES; i++) {
        const x = i * 0.01;
        const base = positions.length;
        positions.push([x, 0, 0], [x + 0.01, 0, 0], [x, 1000, 0]);
        indices.push(base, base + 1, base + 2);
      }
    }
    const perEntity = LOD_MIN_TRIANGLES * 3;
    const vertexData = interleave(positions, (vi) => (vi < perEntity ? 1001 : 2002));
    const ids = new Uint32Array(vertexData.buffer);
    const lod = simplifyIndicesByClustering(vertexData, STRIDE, new Uint32Array(indices), 1.0);
    assert.ok(lod, 'dense co-located strips must still simplify');
    for (let i = 0; i < lod!.length; i += 3) {
      const e0 = ids[lod![i] * STRIDE + 6];
      const e1 = ids[lod![i + 1] * STRIDE + 6];
      const e2 = ids[lod![i + 2] * STRIDE + 6];
      assert.strictEqual(e0, e1);
      assert.strictEqual(e1, e2);
    }
  });

  it('is translation-invariant in output SIZE (cell alignment may differ slightly)', () => {
    const a = strip(LOD_MIN_TRIANGLES, 0.01);
    const b = strip(LOD_MIN_TRIANGLES, 0.01);
    // Shift b far from the origin (same as batch-origin-relative coords).
    for (let i = 0; i < b.vertexData.length; i += STRIDE) b.vertexData[i] += 1e6;
    const lodA = simplifyIndicesByClustering(a.vertexData, STRIDE, a.indices, 1.0)!;
    const lodB = simplifyIndicesByClustering(b.vertexData, STRIDE, b.indices, 1.0)!;
    assert.ok(Math.abs(lodA.length - lodB.length) <= 6, `${lodA.length} vs ${lodB.length}`);
  });
});

describe('lodCellSizeForBounds', () => {
  it('scales with the AABB diagonal', () => {
    const cell = lodCellSizeForBounds([0, 0, 0], [30, 40, 0]);
    assert.ok(Math.abs(cell - 50 * LOD_CELL_FRACTION) < 1e-9);
  });
});
