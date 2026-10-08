/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Real isolated GC witness, invoked by the root Turbo mounted tests (#6584).
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { carryReleasedMesh, meshGeometryCounts } from '../lib/released-mesh-provenance.js';
import { releaseCpuMeshBuffers } from '../lib/geometry-cpu-release.js';

const gc = globalThis.gc;
if (!gc) throw new Error('This witness requires Node --expose-gc');

async function requireCollected(references: readonly WeakRef<object>[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    // WeakRef keeps targets alive until the current job ends. GC and the
    // observation therefore run in different jobs, with no strong target local.
    await new Promise(resolve => setTimeout(resolve, 10));
    gc!();
    await new Promise(resolve => setTimeout(resolve, 10));
    if (references.every(reference => reference.deref() === undefined)) return;
  }
  assert.fail('CPU alias bookkeeping retained a wrapper or a released buffer');
}

const source: MeshData = {
  expressId: 1, geometryItemId: 2, color: [1, 0, 0, 1],
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]),
};

function discardedCopies(): WeakRef<MeshData>[] {
  return Array.from({ length: 1_000 }, () => new WeakRef(carryReleasedMesh(source, { ...source })));
}

// Repeated generations cannot make the registry pin otherwise dead wrappers.
for (let generation = 0; generation < 3; generation++) await requireCollected(discardedCopies());
assert.equal(source.positions.length, 9, 'the source is intentionally still alive');

const retained = carryReleasedMesh(source, { ...source });
const independentIndices = source.indices.slice();
const appearanceOnly = carryReleasedMesh(source, { ...source, positions: source.positions.slice(), normals: source.normals.slice(),
  indices: independentIndices, appearanceSource: { kind: 'canonical-item', indices: independentIndices,
    sourceIndices: source.indices.subarray(0, 0) } });
const buffers = [new WeakRef(source.positions), new WeakRef(source.normals), new WeakRef(source.indices),
  new WeakRef(source.positions.buffer), new WeakRef(source.normals.buffer), new WeakRef(source.indices.buffer),
  new WeakRef(appearanceOnly.appearanceSource!.sourceIndices)];
releaseCpuMeshBuffers([source]);
await requireCollected(buffers);
assert.equal(source.positions.length, 0);
assert.equal(retained.positions.length, 0, 'the retained copy itself stays alive');
assert.deepEqual(meshGeometryCounts(source), { triangles: 1, vertices: 3 });
assert.deepEqual(meshGeometryCounts(retained), { triangles: 1, vertices: 3 });
assert.equal(appearanceOnly.indices, independentIndices, 'independent topology intentionally stays alive');
assert.equal(appearanceOnly.appearanceSource!.indices, independentIndices);
assert.equal(appearanceOnly.appearanceSource!.sourceIndices.buffer.byteLength, 0, 'retained empty view no longer pins the backing buffer');
assert.deepEqual(meshGeometryCounts(appearanceOnly), { triangles: 1, vertices: 3 });
