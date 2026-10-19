/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { executeMesh, executePoints, stageTransform, stageUvs, computeNormalMatrix, computeNormals } from './imported-kernel.js';

test('imported kernel preserves raw source staging, viewer axes, bounds and Uint32 coercion', () => {
  const source = new Float64Array([16777217, 2, 3, 0, -0, -0]);
  const output = executePoints(source, []);
  assert.deepEqual([...output.positions], [16777216, 3, -2, 0, -0, 0]);
  assert.deepEqual(output.bbox, { min: [0, -0, -2], max: [16777216, 3, 0] });
  assert.equal(source[0], 16777217);
  const mesh = executeMesh({ points: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faceVertexIndices: [4294967296, 1.9, 2], faceVertexCounts: [3] }, []);
  assert.deepEqual([...mesh.indices], [0, 1, 2]);
  assert.deepEqual([...mesh.normals], [0, 1, 0, 0, 1, 0, 0, 1, 0]);
});

test('imported kernel keeps empty bounds, nonfinite floats and negative zero', () => {
  assert.deepEqual(executePoints(new Float64Array(), []).bbox, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  const staged = stageUvs([NaN, Infinity, -Infinity, -0, 16777217]);
  assert.ok(Number.isNaN(staged[0]));
  assert.deepEqual([...staged.slice(1)], [Infinity, -Infinity, -0, 16777216]);
});

test('imported kernel retains per-frame identity canonicalization and mesh/point projective behavior', () => {
  const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  assert.equal(stageTransform([identity]), null);
  const input = { points: [[Infinity, 2, 3]], faceVertexIndices: [] };
  assert.equal(executeMesh(input, [identity]).positions[0], Infinity);
  assert.throws(() => executePoints(new Float64Array([Infinity, 2, 3]), [identity]), /IFCx pointcloud:.*homogeneous w/);
  const projective = [[1, 0, 0, 1], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  assert.throws(() => executeMesh({ points: [[0, 0, 0], [-1, 0, 0]], faceVertexIndices: [] }, [projective]), /IFCx geometry:.*homogeneous w/);
  const points = executePoints(new Float32Array([0, 0, 0, -1, 0, 0]), [projective]);
  assert.equal(points.positions[3], -Infinity);
});

test('imported normal helpers preserve perpendicularity and degenerate fallback', () => {
  const m = new Float32Array([2, 0, 0, 0, 1, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1]);
  assert.ok(computeNormalMatrix(m));
  assert.equal(computeNormalMatrix(new Float32Array(16)), null);
  const result = executeMesh({ points: [[0, 0, 0], [1, 0, 1], [0, 1, 0]], faceVertexIndices: [0, 1, 2], normals: [[-1, 0, 1]] }, [[...Array(4)].map((_, i) => [...m.slice(i * 4, i * 4 + 4)])]);
  for (const end of [3, 6]) {
    let dot = 0;
    for (let j = 0; j < 3; j++) dot += (result.positions[end + j] - result.positions[j]) * result.normals[j];
    assert.ok(Math.abs(dot) < 1e-6);
  }
  assert.deepEqual([...computeNormals(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]), new Uint32Array([0, 1, 2]))], Array(9).fill(0));
  const invalid = computeNormals(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Uint32Array([0, 1, 0xaaaaaaab]));
  assert.ok([...invalid.slice(0, 6)].every(Number.isNaN));
  assert.deepEqual([...invalid.slice(6)], [0, 0, 0]);
});

test('static imported target needs neither WebAssembly nor runtime code generation', () => {
  const entry = new URL('../dist/imported-kernel.js', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--disallow-code-generation-from-strings', '--input-type=module', '-e', `
    globalThis.WebAssembly = undefined;
    const NativeArrayBuffer = ArrayBuffer;
    globalThis.ArrayBuffer = class extends NativeArrayBuffer { constructor() { throw Error('eager kernel memory allocation'); } };
    const { executePoints } = await import(${JSON.stringify(entry)});
    globalThis.ArrayBuffer = NativeArrayBuffer;
    const output = executePoints(new Float64Array([1, 2, 3]), []);
    if (output.positions.join(',') !== '1,3,-2') throw Error('wrong point output');
  `], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
