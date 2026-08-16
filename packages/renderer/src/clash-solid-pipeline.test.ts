/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `expandTriangles` is the one piece of `ClashSolidPipeline` that has no GPU
 * dependency: it turns an indexed mesh + one flat colour into the
 * non-indexed pos+color-per-vertex stream the shared `SYMBOLIC_FILL_WGSL`
 * vertex layout expects (stride 7 floats: xyz + rgba). Pinned directly since
 * the GPU pipeline itself needs a real `GPUDevice` this test env doesn't have.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expandTriangles, type ClashSolidInput } from './clash-solid-pipeline.js';

/** Compare through an f32 round-trip: the vertex buffer is Float32Array, so an
 *  input literal like 0.9 legitimately comes back as 0.8999999761581421. */
function assertCloseArray(actual: readonly number[], expected: readonly number[]): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(
      Math.abs(actual[i] - Math.fround(expected[i])) < 1e-6,
      `index ${i}: expected ~${expected[i]}, got ${actual[i]}`,
    );
  }
}

describe('expandTriangles', () => {
  it('expands one triangle into 3 vertices of stride 7 (xyz + rgba)', () => {
    const input: ClashSolidInput = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 0.1, 0.85, 1],
    };
    const out = expandTriangles(input);
    assert.equal(out.length, 3 * 7);
    // Vertex 0: position then colour.
    assertCloseArray([...out.slice(0, 7)], [0, 0, 0, 1, 0.1, 0.85, 1]);
    // Vertex 1.
    assertCloseArray([...out.slice(7, 14)], [1, 0, 0, 1, 0.1, 0.85, 1]);
    // Vertex 2.
    assertCloseArray([...out.slice(14, 21)], [0, 1, 0, 1, 0.1, 0.85, 1]);
  });

  it('every vertex of a two-triangle mesh carries the SAME flat colour', () => {
    const input: ClashSolidInput = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      color: [0.2, 0.4, 0.6, 0.9],
    };
    const out = expandTriangles(input);
    assert.equal(out.length, 6 * 7);
    for (let v = 0; v < 6; v += 1) {
      const rgba = [...out.slice(v * 7 + 3, v * 7 + 7)];
      assertCloseArray(rgba, [0.2, 0.4, 0.6, 0.9]);
    }
  });

  it('reads positions through the INDEX, not vertex order — a reused vertex expands to two copies', () => {
    // Vertex 0 is shared by both triangles at a different index slot.
    const input: ClashSolidInput = {
      positions: new Float32Array([5, 6, 7, 0, 0, 0, 1, 1, 1, 2, 2, 2]),
      indices: new Uint32Array([1, 0, 2, 1, 2, 3]), // vertex 0 (pos [5,6,7]) used twice
      color: [1, 1, 1, 1],
    };
    const out = expandTriangles(input);
    assert.equal(out.length, 6 * 7);
    // First triangle's first vertex is index 1 -> position [0,0,0].
    assert.deepEqual([...out.slice(0, 3)], [0, 0, 0]);
    // Second triangle's first vertex is ALSO index 1 -> [0,0,0] again.
    assert.deepEqual([...out.slice(21, 24)], [0, 0, 0]);
  });

  it('accepts f64 positions (the wasm solid is f64) without losing precision beyond f32 rounding', () => {
    const input: ClashSolidInput = {
      positions: new Float64Array([1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5]),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 0, 0, 1],
    };
    const out = expandTriangles(input);
    assert.deepEqual([...out.slice(0, 3)], [1.5, 2.5, 3.5]);
  });

  it('an empty index list yields an empty stream', () => {
    const input: ClashSolidInput = {
      positions: new Float32Array([0, 0, 0]),
      indices: new Uint32Array([]),
      color: [1, 1, 1, 1],
    };
    assert.equal(expandTriangles(input).length, 0);
  });
});
