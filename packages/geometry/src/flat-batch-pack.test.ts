/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { packFlatBatch, unpackFlatBatch } from './flat-batch-pack.js';
import { attachCanonicalMeshMetadata } from './canonical-mesh-metadata.js';
import type { MeshData } from './types.js';

function mesh(id: number, verts: number, tris: number, extra: Partial<MeshData> = {}): MeshData {
  const positions = Float32Array.from({ length: verts * 3 }, (_, i) => id + i * 0.25);
  const normals = Float32Array.from({ length: verts * 3 }, (_, i) => (i % 3) - 1);
  const indices = Uint32Array.from({ length: tris * 3 }, (_, i) => (i * 7) % verts);
  const m: MeshData = {
    expressId: id, ifcType: 'IfcWall', positions, normals, indices, color: [0.1, 0.2, 0.3, 1],
    origin: [10, 20, 30], localToWorld: Array.from({ length: 16 }, (_, i) => i), geometryClass: 0, geometryItemId: id + 1, ...extra,
  };
  attachCanonicalMeshMetadata(m, { hash: BigInt(id) * 3n, aabb: { min: [0, 0, 0], max: [1, 1, 1] }, volume: 2 });
  return m;
}

/** A deep copy that keeps typed-array types, as the worker built them. */
const copy = (meshes: MeshData[]) => structuredClone(meshes);

/** The worker -> main hop: structured clone with the transfer list, like postMessage. */
function postAndReceive(meshes: MeshData[], transfers: ArrayBuffer[]): MeshData[] {
  const out = packFlatBatch(meshes, transfers);
  const received = structuredClone(out, { transfer: transfers });
  return unpackFlatBatch(received.meshes, received.flatVertices);
}

function ownTransfers(meshes: MeshData[]): ArrayBuffer[] {
  return meshes.flatMap((m) => [m.positions.buffer, m.normals.buffer, m.indices.buffer] as ArrayBuffer[]);
}

describe('packFlatBatch / unpackFlatBatch', () => {
  it('delivers meshes equal to the unpacked batch, with the same key order and one buffer per stream', () => {
    const meshes = [mesh(1, 4, 2), mesh(2, 30, 12), mesh(3, 3, 1, { geometryItemId: undefined })];
    delete (meshes[2] as Partial<MeshData>).geometryItemId;
    const expected = copy(meshes);
    const got = postAndReceive(meshes, ownTransfers(meshes));
    expect(got).toEqual(expected);
    got.forEach((m, k) => expect(Object.keys(m)).toEqual(Object.keys(expected[k])));
    expect(new Set(got.map((m) => m.positions.buffer)).size).toBe(1);
    expect(new Set(got.map((m) => m.indices.buffer)).size).toBe(1);
  });

  it('rebuilds the canonical appearance fence on the delivered index view', () => {
    const got = postAndReceive([mesh(5, 6, 2)], []);
    const a = got[0].appearanceSource!;
    expect(a.indices).toBe(got[0].indices);
    expect(a.sourceIndices).toBe(got[0].indices);
    expect(a).toEqual({ kind: 'canonical-item', indices: got[0].indices, sourceIndices: got[0].indices });
  });

  it('keeps a mesh it cannot pack on the object path, in place, and keeps its buffers on the transfer list', () => {
    const plain = mesh(1, 4, 2);
    const withIds = mesh(2, 4, 2, { entityIds: new Uint32Array([9, 9, 9, 9]) });
    const foreign = mesh(3, 4, 2);
    foreign.appearanceSource = { kind: 'canonical-item', indices: foreign.indices, sourceIndices: new Uint32Array(foreign.indices), cornerIndices: new Uint32Array([0, 1, 2, 3, 4, 5]) };
    const meshes = [plain, withIds, foreign];
    const expected = copy(meshes);
    const transfers = ownTransfers(meshes);
    const keptBuffers = [withIds, foreign].flatMap((m) => [m.positions.buffer, m.normals.buffer, m.indices.buffer]);
    const plainBuffer = plain.positions.buffer;
    const out = packFlatBatch(meshes, transfers);
    for (const b of keptBuffers) expect(transfers).toContain(b);
    expect(transfers).not.toContain(plainBuffer); // copied into the stream, so it no longer moves
    expect(Array.from(out.flatVertices!.packed)).toEqual([1, 0, 0]);
    const received = structuredClone(out, { transfer: transfers });
    expect(unpackFlatBatch(received.meshes, received.flatVertices)).toEqual(expected);
  });

  it('leaves other transferables (textures, side channels) on the list', () => {
    const textured = mesh(4, 4, 2, { uvs: new Float32Array(8) });
    const side = new Uint32Array([1, 2]).buffer;
    const transfers = [...ownTransfers([textured]), textured.uvs!.buffer as ArrayBuffer, side];
    const positionsBuffer = textured.positions.buffer;
    packFlatBatch([textured], transfers);
    expect(transfers).toContain(textured.uvs!.buffer);
    expect(transfers).toContain(side);
    expect(transfers).not.toContain(positionsBuffer);
  });

  it('handles empty normals and empty batches, and passes a batch with nothing packable through unchanged', () => {
    const noNormals = mesh(6, 3, 1, { normals: new Float32Array(0) });
    const expected = copy([noNormals]);
    expect(postAndReceive([noNormals], ownTransfers([noNormals]))).toEqual(expected);
    expect(packFlatBatch([], [])).toEqual({ meshes: [] });
    const only = [mesh(7, 3, 1, { entityIds: new Uint32Array(3) })];
    const transfers = ownTransfers(only);
    const before = [...transfers];
    const out = packFlatBatch(only, transfers);
    expect(out.flatVertices).toBeUndefined();
    expect(out.meshes).toBe(only);
    expect(transfers).toEqual(before);
  });

  it('a batch without packed streams is returned as received', () => {
    const meshes = [mesh(8, 3, 1)];
    expect(unpackFlatBatch(meshes, undefined)).toBe(meshes);
  });
});
