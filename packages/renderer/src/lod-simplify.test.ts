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
} from './lod-simplify.js';

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

/**
 * The same dense-strip shape as `strip()`, but advancing along Z instead of
 * X, with X and Y held at fixed (non-zero-only-by-accident) values. `strip()`
 * alone never gives any vertex a non-zero Z, so a clustering bug that reads
 * the wrong buffer offset for the Z cell (e.g. picking up the always-zero
 * normal lane instead of position.z) is invisible to it: the bogus Z cell
 * and the real one both collapse to 0. This variant makes Z the axis that
 * must be read correctly for the collapse pattern to come out right.
 */
function stripZ(n: number, step: number) {
  const positions: Array<[number, number, number]> = [];
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const z = i * step;
    const base = positions.length;
    positions.push([0, 0, z], [0, 0, z + step], [0, 1000, z]);
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

  it('drops triangles whose corners collapse into one cell along Z (clustering must read Z, not just X/Y)', () => {
    const { vertexData, indices } = stripZ(LOD_MIN_TRIANGLES, 0.01);
    const lod = simplifyIndicesByClustering(vertexData, STRIDE, indices, 1.0);
    assert.ok(lod, 'simplification should pay on a dense Z-strip');
    assert.ok(lod!.length < indices.length * 0.25, `expected big reduction, got ${lod!.length}/${indices.length}`);
    assert.strictEqual(lod!.length % 3, 0);
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

  it('returns what it kept whatever its size when `unconditional` (a caller judging several runs together)', () => {
    const small = strip(LOD_MIN_TRIANGLES - 1, 0.01);
    const floor = simplifyIndicesByClustering(small.vertexData, STRIDE, small.indices, 1.0, { unconditional: true });
    assert.ok(floor && floor.length > 0 && floor.length < small.indices.length, 'below the triangle floor');
    const kept = strip(LOD_MIN_TRIANGLES, 10);
    assert.strictEqual(simplifyIndicesByClustering(kept.vertexData, STRIDE, kept.indices, 0.001, { unconditional: true })?.length, kept.indices.length, 'nothing collapsed');
    const blob = strip(LOD_MIN_TRIANGLES, 0.000001);
    assert.strictEqual(simplifyIndicesByClustering(blob.vertexData, STRIDE, blob.indices, 1000, { unconditional: true })?.length, 0, 'everything collapsed');
    // The same triangles as without it, where the result pays.
    const dense = strip(LOD_MIN_TRIANGLES, 0.01);
    assert.deepStrictEqual(simplifyIndicesByClustering(dense.vertexData, STRIDE, dense.indices, 1.0, { unconditional: true }),
      simplifyIndicesByClustering(dense.vertexData, STRIDE, dense.indices, 1.0));
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
      // Annotated because `assert.strictEqual` is an `asserts actual is T`
      // signature: without a declared type the three inferences reference each
      // other through the assertions and TS gives up (TS7022).
      const e0: number = ids[lod![i] * STRIDE + 6];
      const e1: number = ids[lod![i + 1] * STRIDE + 6];
      const e2: number = ids[lod![i + 2] * STRIDE + 6];
      assert.strictEqual(e0, e1);
      assert.strictEqual(e1, e2);
    }
  });

  it('lets vertex 0 be its own cluster representative', () => {
    // The per-vertex memo is an Int32Array (a Map throws past 2^24 entries,
    // issue #3028), so index 0 is both a real representative and the falsy
    // value.
    //
    // What this test does NOT do, stated because the name would otherwise
    // imply it: it does not pin the -1 sentinel. Mutating the fill to 0 and
    // the guard to `memo !== 0` leaves all ten tests green, verified by
    // running it. A falsy sentinel makes vertex 0 look permanently
    // unmemoized, so it is re-resolved on every reference through the same
    // `cellOfKey` lookup, which returns the same answer. That is a
    // performance regression with no observable output difference, and no
    // assertion on the returned buffer can see it. The sentinel choice is
    // therefore documented at the declaration rather than defended here.
    //
    // What it does pin is that vertex 0 is usable as a representative at all,
    // which a sentinel collision that skipped it would break.
    //
    // Triangle 0 spans three separate cells so it survives; every later
    // triangle has all three corners in one cell so it collapses and is
    // dropped. That guarantees a real reduction (not a null return) and puts
    // vertex 0 in the output as its own representative.
    const positions: Array<[number, number, number]> = [
      [0, 0, 0],
      [10, 0, 0],
      [20, 0, 0],
    ];
    for (let t = 1; t <= LOD_MIN_TRIANGLES + 2; t++) {
      positions.push([100 + t * 10, 0, 0], [100 + t * 10, 0, 0], [100 + t * 10, 0, 0]);
    }
    const data = interleave(positions);
    const indices = new Uint32Array(positions.length);
    for (let i = 0; i < positions.length; i++) indices[i] = i;

    const out = simplifyIndicesByClustering(data, STRIDE, indices, 1);
    assert.ok(out, 'expected simplification to produce a buffer');
    assert.ok(out.includes(0), 'vertex 0 must survive as a cluster representative');
    assert.deepEqual(
      Array.from(out),
      [0, 1, 2],
      'only the spread triangle survives, and it keeps vertex 0 as its own representative',
    );
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

/**
 * One batch as the scene builds it: `pieces` meshes, two per entity, laid out
 * in WORLD space on exact binary fractions. Each piece is one triangle spanning
 * three cells (it survives) and one tiny triangle (it collapses). The two
 * pieces of an entity share their first corner at the same position with
 * different normals, so that cell has coincident candidates from both pieces.
 */
function campusPieces(pieces: number) {
  return Array.from({ length: pieces }, (_, k) => {
    const entity = 100 + (k >> 1);
    const x = (k >> 1) * 4.375 + 0.375, y = 0.625, z = 0.125, d = 1 / 64;
    const odd = (k & 1) === 1;
    const n = odd ? [0, 0, 1] : [0, 1, 0];
    const big = odd ? [[x, y], [x + 2.5, y + 2.5], [x, y + 2.5]] : [[x, y], [x + 2.5, y], [x, y + 2.5]];
    return { entity, vertices: [...big, [x + d, y + d], [x + 2 * d, y + d], [x + d, y + 2 * d]].map(([px, py]) => [px, py, z, ...n]) };
  });
}

/** The batch the pieces make in `order`, its positions relative to `frame`. */
function batchOf(pieces: ReturnType<typeof campusPieces>, order: readonly number[], frame: readonly [number, number, number]) {
  const vertexData = new Float32Array(pieces.length * 6 * STRIDE);
  const lanes = new Uint32Array(vertexData.buffer);
  const indices = new Uint32Array(pieces.length * 6);
  order.forEach((k, slot) => pieces[k].vertices.forEach((v, i) => {
    const at = (slot * 6 + i) * STRIDE;
    vertexData.set([v[0] - frame[0], v[1] - frame[1], v[2] - frame[2], v[3], v[4], v[5]], at);
    lanes[at + 6] = pieces[k].entity;
    indices[slot * 6 + i] = slot * 6 + i;
  }));
  return { vertexData, indices };
}

/** Each LOD triangle as the world-space records of its corners, sorted: what the GPU draws. */
function drawnTriangles(vertexData: Float32Array, lod: Uint32Array, frame: readonly [number, number, number]) {
  const lanes = new Uint32Array(vertexData.buffer);
  const record = (v: number) => {
    const at = v * STRIDE;
    return [vertexData[at] + frame[0], vertexData[at + 1] + frame[1], vertexData[at + 2] + frame[2],
      vertexData[at + 3], vertexData[at + 4], vertexData[at + 5], lanes[at + 6]].join(',');
  };
  const out: string[] = [];
  for (let i = 0; i < lod.length; i += 3) out.push([lod[i], lod[i + 1], lod[i + 2]].map(record).join(' '));
  return out.sort();
}

describe('simplifyIndicesByClustering is a function of the batch contents (load order)', () => {
  const pieces = campusPieces(400); // 800 triangles: above LOD_MIN_TRIANGLES
  const inOrder = pieces.map((_, k) => k);
  const reversed = [...inOrder].reverse();
  const origin: [number, number, number] = [0, 0, 0];
  // Exact binary fractions: every position is exact in both frames, so only the frame differs.
  const shifted: [number, number, number] = [3.5, -2.25, 7];
  /** What the GPU draws at LOD1 for the batch the pieces make in `order`, in `frame`. */
  const drawn = (order: readonly number[], frame: readonly [number, number, number]) => {
    const { vertexData, indices } = batchOf(pieces, order, frame);
    const lod = simplifyIndicesByClustering(vertexData, STRIDE, indices, 1, { frameOrigin: frame });
    assert.ok(lod, 'the batch must simplify');
    assert.strictEqual(lod.length, pieces.length * 3, 'every big triangle survives, every tiny one collapses');
    return drawnTriangles(vertexData, lod, frame);
  };

  it('draws the same triangles whatever order the pieces arrived in', () => {
    assert.deepStrictEqual(drawn(reversed, origin), drawn(inOrder, origin));
  });

  it('draws the same triangles whichever frame the batch is in', () => {
    assert.deepStrictEqual(drawn(inOrder, shifted), drawn(inOrder, origin));
  });

  it('elects the coincident vertex with the smaller normal, not the first one referenced', () => {
    for (const order of [inOrder, reversed]) {
      // Entity 100's shared corner (0.375, 0.625, 0.125): +Z (0,0,1) sorts before +Y (0,1,0).
      const corners = drawn(order, origin).flatMap((t) => t.split(' ')).filter((r) => r.startsWith('0.375,0.625,0.125,'));
      assert.deepStrictEqual([...new Set(corners)], ['0.375,0.625,0.125,0,0,1,100']);
    }
  });
});

describe('simplifyIndicesByClustering layout argument', () => {
  it('keeps the numeric form free of a normal tie-break, as before', () => {
    // Entity 100's coincident corner: by index the +Y piece (piece 0) comes first; the normal rule would pick +Z.
    const pieces = campusPieces(400);
    const { vertexData, indices } = batchOf(pieces, pieces.map((_, k) => k), [0, 0, 0]);
    const lod = simplifyIndicesByClustering(vertexData, STRIDE, indices, 1, 6)!;
    const corners = drawnTriangles(vertexData, lod, [0, 0, 0]).flatMap((t) => t.split(' ')).filter((r) => r.startsWith('0.375,0.625,0.125,'));
    assert.deepStrictEqual([...new Set(corners)], ['0.375,0.625,0.125,0,1,0,100']);
  });

  it('still reads a bare number as the entity-lane offset', () => {
    const pieces = campusPieces(400);
    const order = pieces.map((_, k) => k);
    const { vertexData, indices } = batchOf(pieces, order, [0, 0, 0]);
    const numeric = simplifyIndicesByClustering(vertexData, STRIDE, indices, 1, 6);
    assert.ok(numeric, 'the batch must simplify');
    assert.strictEqual(numeric.length, pieces.length * 3, 'the lane offset is honoured: no cross-entity merges');
  });

  it('ranks a NaN normal last, whichever vertex comes first', () => {
    const pieces = campusPieces(400);
    // Piece 1 (entity 100, +Z normal) gets a NaN normal: piece 0's +Y corner must win in either order.
    pieces[1].vertices = pieces[1].vertices.map(([x, y, z]) => [x, y, z, NaN, 0, 1]);
    for (const order of [pieces.map((_, k) => k), pieces.map((_, k) => k).reverse()]) {
      const { vertexData, indices } = batchOf(pieces, order, [0, 0, 0]);
      const lod = simplifyIndicesByClustering(vertexData, STRIDE, indices, 1)!;
      const corners = drawnTriangles(vertexData, lod, [0, 0, 0]).flatMap((t) => t.split(' ')).filter((r) => r.startsWith('0.375,0.625,0.125,'));
      assert.deepStrictEqual([...new Set(corners)], ['0.375,0.625,0.125,0,1,0,100']);
    }
  });
});

describe('simplifyIndicesByClustering at the V8 Map ceiling (issue #3028)', () => {
  // The defect this guards needs more than 2^24 - 1 distinct referenced
  // vertices in ONE batch, which is ~16.7 million. There is no cheap fixture
  // for that: the buffers alone are a few hundred MB, so this cannot run on
  // every commit.
  //
  // It is therefore DEMANDABLE rather than skipped-and-forgotten, following
  // `fixture_or_skip!` / IFC_LITE_REQUIRE_FIXTURES on the Rust side. Set
  // IFC_LITE_HEAVY_TESTS=1 to run it.
  //
  // Being honest about why this exists at all: with it skipped, reverting the
  // fix (Int32Array back to Map) leaves every other test in this file green.
  // I ran that mutation to check. So without this, the change has no
  // regression test, and saying so is better than implying the other tests
  // cover it.
  const heavy = process.env.IFC_LITE_HEAVY_TESTS === '1';

  it(
    'memoizes past 2^24 vertices without throwing RangeError',
    { skip: heavy ? false : 'set IFC_LITE_HEAVY_TESTS=1 (allocates ~340MB)' },
    () => {
      // Stride 3 keeps the vertex buffer as small as this can be: no normals,
      // no entity lane.
      //
      // Every vertex sits at the SAME position, which matters. The per-vertex
      // memo grows to 2^24 entries while the cell map stays at ONE. Spreading
      // them out instead would overflow the CELL map first, and its own bail
      // returns null before the per-vertex memo is ever stressed, so the test
      // would pass with the defect present. I found that by running the
      // mutation, not by reasoning about it.
      const STRIDE_MIN = 3;
      // The count has to EXCEED 2 ** 24 - 1 distinct references, not reach it:
      // a Map throws on the insert that would take it past the cap, so landing
      // exactly on it passes. `n = 2 ** 24 + 1` rounded down to a multiple of
      // three gives 2 ** 24 - 1 references, one short, and the test passed with
      // the defect present. Caught by running the mutation.
      const n = 2 ** 24 + 3;
      const data = new Float32Array(n * STRIDE_MIN);
      const indices = new Uint32Array(n - (n % 3));
      for (let i = 0; i < indices.length; i++) indices[i] = i;
      assert.ok(
        indices.length > 2 ** 24 - 1,
        `fixture must exceed the Map cap; got ${indices.length} references`,
      );

      // Before the fix this threw `RangeError: Map maximum size exceeded`
      // from the per-vertex memo, which rejected the whole finalize and left
      // the viewer showing streaming fragments.
      const out = simplifyIndicesByClustering(data, STRIDE_MIN, indices, 1);

      // Nothing collapses, so the honest outcome is null ("simplification
      // does not pay"), NOT a throw. Either a buffer or null is a pass here;
      // the assertion is that we got a verdict at all.
      assert.ok(out === null || out instanceof Uint32Array);
    },
  );
});

describe('lodCellSizeForBounds', () => {
  it('scales with the AABB diagonal', () => {
    const cell = lodCellSizeForBounds([0, 0, 0], [30, 40, 0]);
    assert.ok(Math.abs(cell - 50 * LOD_CELL_FRACTION) < 1e-9);
  });
});
