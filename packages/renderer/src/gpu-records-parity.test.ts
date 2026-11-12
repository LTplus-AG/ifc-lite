/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { batchCollapseVerdict, encodeMeshRecords, recordsDescribe, shiftedRecords, MAX_QUANT_EXTENT, QUANT_STEP, type MeshRecords } from '@ifc-lite/geometry/gpu-records';
import { mergeGeometry } from './scene-geometry.js';
import { latticeCollapsesGeometry, quantizeInterleaved } from './quantize.js';
import { originPreservesTriangleTopology } from './scene-precision.js';

/**
 * Records encoded per mesh (in a geometry worker, M2) against the mesh's own
 * lattice origin, then shifted to the origin the renderer's quantizer picks for
 * the batch (`shiftedRecords`, an exact integer shift), must be the bytes the
 * batch merge and quantizer write for the same meshes in the same frame, so a
 * fragment can be their concatenation. Compared byte for byte; failures name one byte.
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
    // The bucket's first fragment (no shared origin yet: the quantizer centres one on it) and a later fragment
    // quantizing against an origin an earlier fragment set (lattice-aligned, below the data, within u16 range).
    for (const shared of [false, true]) it(`${name}${shared ? ', against a shared origin' : ', first fragment'}`, () => {
      const frame = mergeGeometry([meshes[0]]).origin; // the automatic frame a first fragment would pick
      const encoded = meshes.map((m) => encodeMeshRecords(m, frame));
      for (const [i, m] of meshes.entries()) {
        // Every mesh here spans well under 64 m, so only the f32 topology check may refuse one.
        assert.equal(encoded[i] === null, !originPreservesTriangleTopology([m], frame), `mesh ${i}: refused exactly when its topology breaks`);
      }
      const kept = meshes.filter((_, i) => encoded[i] !== null);
      assert.ok(kept.length > 0, `${name}: some mesh encodes`);
      const records = encoded.filter((r): r is MeshRecords => r !== null);
      const merged = mergeGeometry(kept, frame);
      const relMin = [0, 1, 2].map((a) => Math.min(...records.map((r) => r.relMin[a])));
      const lattice: { min?: [number, number, number] } = shared
        ? { min: [0, 1, 2].map((a) => Math.floor(relMin[a] / QUANT_STEP) * QUANT_STEP - 1000 * QUANT_STEP) as [number, number, number] } : {};
      const latticeForRecords = shared ? { min: [...lattice.min!] as [number, number, number] } : {};
      const quantized = quantizeInterleaved(merged.vertexData, 7, lattice);
      assert.ok(quantized, 'the batch quantizes');
      if (shared) assert.deepEqual(quantized.quantMin, lattice.min, 'the batch takes the shared origin');
      // What fromRecords does: the quantizer's origin (centred first fragment, or the shared one), each mesh shifted to it.
      const target = shared ? latticeForRecords.min! : quantized.quantMin;
      const concat = new Uint8Array(records.reduce((n, r) => n + r.records.byteLength, 0));
      let at = 0;
      for (const r of records) { assert.ok(shiftedRecords(r, target, concat, at), 'shift in range'); at += r.records.byteLength; }
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

  it('the shift is exact up to the u16 limit and refused one step beyond it', () => {
    // One mesh spanning (nearly) the full 64 m lattice range on x: its own q reaches qMax.
    const m = mesh(700, [0, 0, 0], 1);
    m.positions[0] = 0; m.positions[3] = MAX_QUANT_EXTENT - 2 * QUANT_STEP;
    const r = encodeMeshRecords(m, [0, 0, 0])!;
    assert.ok(r, 'a 64 m mesh encodes');
    const headroom = 65535 - r.qMax[0];
    assert.ok(headroom >= 0 && headroom < 4, `qMax ${r.qMax[0]} sits at the top of u16`);
    const at = (k: number): [number, number, number] => [r.pin[0] - k * QUANT_STEP, r.pin[1], r.pin[2]];
    const out = new Uint8Array(r.records.byteLength);
    assert.ok(shiftedRecords(r, at(headroom), out, 0), 'the largest legal shift is taken');
    const direct = new Uint16Array(r.records), shifted = new Uint16Array(out.buffer);
    for (let v = 0; v < direct.length / 6; v++) {
      assert.equal(shifted[v * 6], direct[v * 6] + headroom, `vertex ${v}: x shifted by exactly ${headroom}`);
      assert.equal(shifted[v * 6 + 3], direct[v * 6 + 3], `vertex ${v}: normal untouched`);
    }
    assert.equal(Math.max(...Array.from({ length: direct.length / 6 }, (_, v) => shifted[v * 6])), 65535 - (65535 - r.qMax[0] - headroom), 'no wrap-around');
    const untouched = new Uint8Array(r.records.byteLength).fill(7);
    assert.equal(shiftedRecords(r, at(headroom + 1), untouched, 0), false, 'one step beyond u16 is refused');
    assert.ok(untouched.every((b) => b === 7), 'a refused shift writes nothing');
    assert.equal(shiftedRecords(r, [r.pin[0] + QUANT_STEP, r.pin[1], r.pin[2]], untouched, 0), false, 'an origin above the mesh is refused');
    assert.equal(shiftedRecords(r, [r.pin[0] - QUANT_STEP / 2, r.pin[1], r.pin[2]], untouched, 0), false, 'an origin off the lattice is refused');
  });

  it('refuses a mesh wider than the u16 lattice range, and a non-finite one', () => {
    const wide = mesh(500, [0, 0, 0], 2); wide.positions[0] = -1; wide.positions[3] = MAX_QUANT_EXTENT;
    assert.equal(encodeMeshRecords(wide, [0, 0, 0]), null, 'wider than 64 m on x');
    const bad = mesh(501, [0, 0, 0], 2); bad.positions[4] = NaN;
    assert.equal(encodeMeshRecords(bad, [0, 0, 0]), null, 'NaN');
  });

  it('records describe only the mesh they were encoded from', () => {
    const m = mesh(600, [1, 1, 1], 2);
    const r = encodeMeshRecords(m, [0, 0, 0])!;
    assert.ok(recordsDescribe(r, m), 'the encoded mesh');
    assert.ok(recordsDescribe(r, { ...m }), 'a copy sharing its positions, origin and colour (a placed primary-model mesh)');
    assert.ok(!recordsDescribe(r, { ...m, positions: new Float32Array(m.positions) }), 'other positions (a split piece, a lifted placement)');
    assert.ok(!recordsDescribe(r, { ...m, origin: [0, 0, 5] }), 'a moved origin (a translated model)');
    assert.ok(!recordsDescribe(r, { ...m, color: [0.1, 0.9, 0.2, 1] }), 'another colour salt');
  });

});
