/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { MeshData } from '@ifc-lite/geometry';
import { meshBounds, meshBoundsIndex, summarizeGeometryChange, type Aabb } from './geometrySummary.js';

/**
 * `MeshData.positions` are per-element LOCAL-frame coordinates on the wasm
 * path: world vertex i = `origin + positions[3i..3i+3]`, and the local frame
 * is the DEFAULT there (`rust/geometry/src/router/transforms/mod.rs`). The
 * origin is the element's AABB centre, so it FOLLOWS the element: a pure
 * translation leaves `positions` byte-identical and moves only `origin`.
 *
 * `meshBounds` summed raw `positions`, so a genuinely moved element reported
 * `movedDistance = 0, reshaped = false` - no "Moved" badge in the panel and
 * `MovedDistance_m = 0` in the bulk CSV that #2529 extracted this logic into.
 * Every fixture in #2529's tests built meshes WITHOUT `origin`, which is why
 * the gap was invisible. These fixtures carry one.
 */

function mesh(
  expressId: number,
  positions: readonly number[],
  extras: { origin?: [number, number, number]; geometryAabb?: Aabb } = {},
): MeshData {
  return {
    expressId,
    positions: new Float32Array(positions),
    ...extras,
  } as unknown as MeshData;
}

/** Unit cube centred on its own local origin - the shape the wasm local frame
 *  produces (origin = element AABB centre, positions relative to it). */
const UNIT_CUBE = [
  -0.5, -0.5, -0.5,
  0.5, -0.5, -0.5,
  0.5, 0.5, 0.5,
  -0.5, 0.5, 0.5,
];

describe('meshBounds folds MeshData.origin (#2529 regression)', () => {
  it('reports a pure translation carried only by origin as a move with the true distance', () => {
    // Identical positions on both sides; only the per-element origin moved,
    // exactly what the wasm local-frame pipeline emits for a moved element.
    const ba = meshBounds([mesh(7, UNIT_CUBE, { origin: [10, 2, 3] })], 7);
    const bb = meshBounds([mesh(7, UNIT_CUBE, { origin: [50, 2, 3] })], 7);
    assert.ok(ba && bb, 'both sides must produce a box');
    const summary = summarizeGeometryChange(ba, bb)!;
    assert.ok(
      Math.abs(summary.movedDistance - 40) < 1e-6,
      `element moved 40 m via origin only; got movedDistance = ${summary.movedDistance}`,
    );
    assert.strictEqual(summary.reshaped, false, 'a pure translation is not a reshape');
  });

  it('still detects a reshape when origin is non-zero (not everything reads as moved)', () => {
    // Same origin both sides; the mesh itself grew 1 m in local x. The fold
    // must not blur a real shape change into a phantom move-only answer.
    const grown = [
      -1.5, -0.5, -0.5,
      0.5, -0.5, -0.5,
      0.5, 0.5, 0.5,
      -0.5, 0.5, 0.5,
    ];
    const ba = meshBounds([mesh(7, UNIT_CUBE, { origin: [10, 2, 3] })], 7);
    const bb = meshBounds([mesh(7, grown, { origin: [10, 2, 3] })], 7);
    const summary = summarizeGeometryChange(ba, bb)!;
    assert.strictEqual(summary.reshaped, true, 'the box grew 1 m in x - that is a reshape');
    assert.ok(Math.abs(summary.sizeDelta.x - 1) < 1e-6, `sizeDelta.x = ${summary.sizeDelta.x}`);
  });

  it('keeps precision at georeferenced world coordinates (origin is f64)', () => {
    // The local frame exists precisely so f32 positions stay element-small at
    // georef scale; the fold must do the world reconstruction in f64 and keep
    // a 40 m move readable next to a 4,200 km coordinate.
    const ba = meshBounds([mesh(7, UNIT_CUBE, { origin: [4200000, 30, 5100000] })], 7);
    const bb = meshBounds([mesh(7, UNIT_CUBE, { origin: [4200040, 30, 5100000] })], 7);
    const summary = summarizeGeometryChange(ba, bb)!;
    assert.ok(
      Math.abs(summary.movedDistance - 40) < 1e-6,
      `expected 40 m at georef scale, got ${summary.movedDistance}`,
    );
    assert.strictEqual(summary.reshaped, false);
  });

  it('unions all submeshes of the entity and ignores other entities', () => {
    const meshes = [
      mesh(7, [-0.5, 0, 0, 0.5, 0, 0], { origin: [10, 0, 0] }),
      mesh(7, [0, -2, 0, 0, 2, 0], { origin: [10, 0, 0] }),
      mesh(8, [100, 100, 100], { origin: [1000, 0, 0] }), // different element
    ];
    assert.deepStrictEqual(meshBounds(meshes, 7), {
      min: [9.5, -2, 0],
      max: [10.5, 2, 0],
    });
  });

  it('prefers the wasm world box (geometryAabb) over folding positions', () => {
    // `geometryAabb` is ABSOLUTE world - RTC offset AND origin already folded
    // (see `MeshData.geometryAabb` / buildFingerprints.ts). Two revisions that
    // chose different RTC offsets agree only through it, so when the hashing
    // pass produced one it must win over any locally folded box.
    const withBox = mesh(7, UNIT_CUBE, {
      origin: [10, 2, 3],
      geometryAabb: { min: [109.5, 1.5, 2.5], max: [110.5, 2.5, 3.5] },
    });
    assert.deepStrictEqual(meshBounds([withBox], 7), {
      min: [109.5, 1.5, 2.5],
      max: [110.5, 2.5, 3.5],
    });
  });

  it('returns null for an absent entity and for an entity with empty positions', () => {
    assert.strictEqual(meshBounds([mesh(7, UNIT_CUBE)], 99), null);
    assert.strictEqual(meshBounds([mesh(7, [])], 7), null);
  });

  it('treats absent origin as world positions (legacy / native meshes)', () => {
    assert.deepStrictEqual(meshBounds([mesh(7, [1, 2, 3, 5, 6, 7])], 7), {
      min: [1, 2, 3],
      max: [5, 6, 7],
    });
  });
});

describe('meshBoundsIndex (the bulk-report twin, #2529)', () => {
  it('agrees with meshBounds for every entity, origin fold included', () => {
    const meshes = [
      mesh(7, UNIT_CUBE, { origin: [10, 2, 3] }),
      mesh(7, [0, -2, 0, 0, 2, 0], { origin: [10, 2, 3] }),
      mesh(8, UNIT_CUBE, {
        origin: [50, 0, 0],
        geometryAabb: { min: [49.5, -0.5, -0.5], max: [50.5, 0.5, 0.5] },
      }),
      mesh(9, []),
    ];
    const index = meshBoundsIndex(meshes);
    assert.deepStrictEqual(index.get(7), meshBounds(meshes, 7));
    assert.deepStrictEqual(index.get(8), meshBounds(meshes, 8));
    assert.strictEqual(index.has(9), false, 'an entity with no vertices gets no box');
  });
});
