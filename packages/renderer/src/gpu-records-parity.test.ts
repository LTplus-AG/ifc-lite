/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { batchCollapseVerdict, encodeMeshRecords, type MeshRecords } from '@ifc-lite/geometry/gpu-records';
import { mergeGeometry } from './scene-geometry.js';
import { latticeCollapsesGeometry, quantizeInterleaved } from './quantize.js';
import { originPreservesTriangleTopology } from './scene-precision.js';
import { cellLatticePin } from './scene-stream-assembly.js';

/**
 * Records encoded per mesh (in a geometry worker, M2) must be the bytes the
 * renderer's batch merge and quantizer write for the same meshes in the same
 * frame against the same lattice origin, so a fragment can be their
 * concatenation. Compared byte for byte; failures name one byte.
 */
let seed = 9684;
const random = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

function mesh(id: number, at: [number, number, number], size: number, options: { origin?: [number, number, number]; ids?: boolean; normals?: boolean } = {}): MeshData {
  const count = 4 + Math.floor(random() * 40);
  const positions = new Float32Array(count * 3), normals = new Float32Array(options.normals === false ? 0 : count * 3);
  for (let i = 0; i < count * 3; i++) positions[i] = at[i % 3] + random() * size;
  for (let i = 0; i < normals.length; i += 3) {
    const [x, y, z] = [random() - 0.5, random() - 0.5, random() - 0.5], l = Math.hypot(x, y, z) || 1;
    normals[i] = x / l; normals[i + 1] = y / l; normals[i + 2] = z / l;
  }
  const indices = new Uint32Array(Math.floor((count - 2)) * 3);
  for (let t = 0; t < indices.length; t += 3) { indices[t] = 0; indices[t + 1] = t / 3 + 1; indices[t + 2] = t / 3 + 2; }
  const color: [number, number, number, number] = [random(), random(), random(), 1];
  return { expressId: id, modelIndex: 0, color, positions, normals, indices,
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.ids ? { entityIds: Uint32Array.from({ length: count }, (_, i) => id + (i % 3)) } : {}) } as MeshData;
}

function firstDifference(a: Uint8Array, b: Uint8Array): string | null {
  if (a.length !== b.length) return `length ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `byte ${i} (vertex ${Math.floor(i / 12)}): ${a[i]} vs ${b[i]}`;
  return null;
}

describe('per-mesh GPU records equal the batch merge and quantizer', () => {
  const geo: [number, number, number] = [2_600_000, 1_200_000, 400];
  const cases: Array<{ name: string; meshes: MeshData[] }> = [
    { name: 'local meshes', meshes: Array.from({ length: 12 }, (_, i) => mesh(100 + i, [3 + i, 5, 2], 6)) },
    { name: 'georeferenced origins', meshes: Array.from({ length: 12 }, (_, i) => mesh(200 + i, [1 + i * 0.5, 2, 1], 8, { origin: geo })) },
    { name: 'per-vertex entity ids and no normals', meshes: Array.from({ length: 8 }, (_, i) => mesh(300 + i, [2, 2, 2], 4, { ids: true, normals: i % 2 === 0 })) },
    { name: 'sub-millimetre rods', meshes: Array.from({ length: 8 }, (_, i) => mesh(400 + i, [4, 4 + i, 4], 0.0015)) },
  ];
  for (const { name, meshes } of cases) {
    it(name, () => {
      const anchor = meshes[0];
      const frame = mergeGeometry([anchor]).origin; // the automatic frame a first fragment would pick
      const pin = cellLatticePin(anchor, 32, [0, 0, 0], frame)!;
      assert.ok(pin, 'a pin');
      const encoded = meshes.map((m) => encodeMeshRecords(m, frame, pin));
      const kept = meshes.filter((_, i) => encoded[i] !== null);
      for (const [i, m] of meshes.entries()) {
        // Every mesh here lies inside its pin's range, so only the f32 topology check may refuse one.
        assert.equal(encoded[i] === null, !originPreservesTriangleTopology([m], frame), `mesh ${i}: refused exactly when its topology breaks`);
      }
      assert.ok(kept.length > 0, `${name}: some mesh encodes`);
      const records = encoded.filter((r): r is MeshRecords => r !== null);
      const merged = mergeGeometry(kept, frame);
      const quantized = quantizeInterleaved(merged.vertexData, 7, { min: [pin[0], pin[1], pin[2]] });
      assert.ok(quantized, 'the batch quantizes');
      assert.deepEqual(quantized.quantMin, [pin[0], pin[1], pin[2]], 'the batch takes the pin');
      const concat = new Uint8Array(records.reduce((n, r) => n + r.records.byteLength, 0));
      let at = 0;
      for (const r of records) { concat.set(new Uint8Array(r.records), at); at += r.records.byteLength; }
      const difference = firstDifference(concat, new Uint8Array(quantized.vertexData));
      assert.ok(difference === null, `${name}: ${difference}`);
      const min = [0, 1, 2].map((axis) => Math.min(...records.map((r) => r.worldMin[axis])));
      const max = [0, 1, 2].map((axis) => Math.max(...records.map((r) => r.worldMax[axis])));
      assert.deepEqual(min, merged.bounds.min, 'world bounds min');
      assert.deepEqual(max, merged.bounds.max, 'world bounds max');
      const verdict = batchCollapseVerdict(records);
      const exact = latticeCollapsesGeometry(merged.vertexData, 7, merged.indices) ? 'f32' : 'quantize';
      assert.ok(verdict === 'unsure' || verdict === exact, `${name}: collapse verdict ${verdict} vs exact ${exact}`);
    });
  }

  it('refuses a vertex outside the u16 range above the pin, and a non-finite one', () => {
    const m = mesh(500, [0, 0, 0], 2);
    assert.equal(encodeMeshRecords(m, [0, 0, 0], [1, 0, 0]), null, 'below the pin');
    assert.equal(encodeMeshRecords(m, [0, 0, 0], [-70, 0, 0]), null, 'beyond 64 m above the pin');
    const bad = mesh(501, [0, 0, 0], 2); bad.positions[4] = NaN;
    assert.equal(encodeMeshRecords(bad, [0, 0, 0], [-1, -1, -1]), null, 'NaN');
  });
});
