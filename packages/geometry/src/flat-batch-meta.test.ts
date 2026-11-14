/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { packFlatBatch, unpackFlatBatch } from './flat-batch-pack.js';
import { attachCanonicalMeshMetadata } from './canonical-mesh-metadata.js';
import type { MeshData } from './types.js';

/** A mesh with the worker's fields in the worker's order (`collectMeshes`). */
function workerMesh(id: number, opts: { origin?: boolean; bounds?: boolean; l2w?: boolean; item?: boolean; material?: boolean; hash?: boolean; type?: string } = {}): MeshData {
  const positions = Float32Array.from({ length: 12 }, (_, i) => id + i / 8);
  const normals = Float32Array.from({ length: 12 }, (_, i) => (i % 3) - 1);
  const indices = Uint32Array.from([0, 1, 2, 2, 3, 0]);
  const m: MeshData = {
    expressId: id, ifcType: opts.type ?? 'IfcWall', positions, normals, indices, color: [0.1, 0.2, 0.30000001192092896, 1],
    ...(opts.origin ? { origin: [1e6 + 0.125, -2.5, -0] as [number, number, number] } : {}),
    ...(opts.bounds ? { localBounds: { min: [0, 0, 0] as [number, number, number], max: [1, 2, 3] as [number, number, number] } } : {}),
    ...(opts.l2w ? { localToWorld: Array.from({ length: 16 }, (_, i) => (i % 5 ? i * 0.1 : 1)) } : {}),
    geometryClass: id % 3,
    ...(opts.item ? { geometryItemId: id + 100 } : {}),
    ...(opts.material ? { materialId: 4294967295 } : {}),
  };
  if (opts.hash) attachCanonicalMeshMetadata(m, { hash: 0xfedcba9876543210n + BigInt(id), aabb: { min: [-1, -2, -3], max: [4, 5, 6] }, volume: 7.25 });
  else attachCanonicalMeshMetadata(m);
  return m;
}

function postAndReceive(meshes: MeshData[]): { got: MeshData[]; posted: unknown[] } {
  const transfers = meshes.flatMap((m) => [m.positions.buffer, m.normals.buffer, m.indices.buffer] as ArrayBuffer[]);
  const out = packFlatBatch(meshes, transfers);
  const received = structuredClone(out, { transfer: transfers });
  const posted = [...received.meshes]; // what crossed the wire, before the rebuild fills the 0 slots in place
  return { got: unpackFlatBatch(received.meshes, received.flatVertices), posted };
}

describe('flat-batch metadata columns', () => {
  it('rebuilds every field combination with the same keys, order and values, and posts those meshes as 0', () => {
    const combos = [{}, { origin: true }, { origin: true, bounds: true, l2w: true }, { item: true }, { item: true, hash: true },
      { origin: true, bounds: true, l2w: true, item: true, material: true, hash: true, type: 'IfcSlab' }, { material: true, type: 'IfcBeam' }];
    const meshes = combos.map((c, k) => workerMesh(10 + k, c));
    const expected = structuredClone(meshes);
    const { got, posted } = postAndReceive(meshes);
    expect(got).toEqual(expected);
    got.forEach((m, k) => {
      expect(Object.keys(m)).toEqual(Object.keys(expected[k]));
      if (m.appearanceSource) expect(m.appearanceSource.indices).toBe(m.indices);
    });
    expect(posted.every((m) => m === 0)).toBe(true);
    expect(Object.is(got[1].origin![2], -0)).toBe(true);
    expect(got[4].geometryHash).toBe(0xfedcba9876543210n + 14n);
  });

  it('keeps a mesh with any other field, or another key order, as an object in its place', () => {
    const shaded = workerMesh(20, { origin: true });
    (shaded as MeshData).shadingColor = [0.5, 0.5, 0.5, 1];
    const reordered = workerMesh(21);
    const { expressId, ...rest } = reordered;
    const moved = { ...rest, expressId } as MeshData; // expressId last
    const plain = workerMesh(22, { item: true, hash: true });
    const meshes = [shaded, moved, plain];
    const expected = structuredClone(meshes);
    const { got, posted } = postAndReceive(meshes);
    expect(got).toEqual(expected);
    got.forEach((m, k) => expect(Object.keys(m)).toEqual(Object.keys(expected[k])));
    expect(posted[0]).not.toBe(0);
    expect(posted[1]).not.toBe(0);
    expect(posted[2]).toBe(0);
  });

  it('keeps a mesh whose values the columns cannot hold exactly as an object', () => {
    const noType = workerMesh(30);
    (noType as { ifcType?: string }).ifcType = undefined;
    const badId = workerMesh(31);
    badId.expressId = 1.5;
    const meshes = [noType, badId, workerMesh(32)];
    const expected = structuredClone(meshes);
    const { got, posted } = postAndReceive(meshes);
    expect(got).toEqual(expected);
    expect(posted.map((m) => m === 0)).toEqual([false, false, true]);
  });
});
