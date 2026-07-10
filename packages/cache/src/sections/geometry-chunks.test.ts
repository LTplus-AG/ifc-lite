/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import {
  buildGeometrySectionV13,
  openGeometryChunksV13,
  readGeometryV13,
  groupMeshesIntoChunks,
  deflateRaw,
  inflateRaw,
} from './geometry-chunks.js';
import { GeometryChunkFlags } from '../types.js';

const coordInfo = (overrides: Partial<CoordinateInfo> = {}): CoordinateInfo => ({
  originShift: { x: 1.5, y: -2.5, z: 1e6 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } },
  shiftedBounds: { min: { x: -5, y: -5, z: -5 }, max: { x: 5, y: 5, z: 5 } },
  hasLargeCoordinates: true,
  ...overrides,
});

function mesh(expressId: number, at: [number, number, number], opts: Partial<MeshData> = {}): MeshData {
  // A tiny triangle anchored at `at` (positions local, origin = at).
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [0.5, 0.25, 0.125, 1],
    ifcType: 'IFCWALL',
    geometryClass: 0,
    origin: at,
    ...opts,
  };
}

const sortById = (meshes: MeshData[]) => [...meshes].sort((a, b) => a.expressId - b.expressId);

function expectMeshesEqual(actual: MeshData[], expected: MeshData[]) {
  const a = sortById(actual);
  const e = sortById(expected);
  expect(a.length).toBe(e.length);
  for (let i = 0; i < a.length; i++) {
    expect(a[i].expressId).toBe(e[i].expressId);
    expect(a[i].ifcType).toBe(e[i].ifcType);
    expect(a[i].geometryClass ?? 0).toBe(e[i].geometryClass ?? 0);
    expect(a[i].color).toEqual(e[i].color);
    // Format semantics: a [0,0,0] origin means "absolute" and restores as
    // undefined (v6+ behaviour, unchanged in v13).
    const normOrigin = (o?: [number, number, number]) =>
      o && (o[0] || o[1] || o[2]) ? o : undefined;
    expect(normOrigin(a[i].origin)).toEqual(normOrigin(e[i].origin));
    expect(Array.from(a[i].positions)).toEqual(Array.from(e[i].positions));
    expect(Array.from(a[i].normals)).toEqual(Array.from(e[i].normals));
    expect(Array.from(a[i].indices)).toEqual(Array.from(e[i].indices));
  }
}

describe('deflateRaw/inflateRaw', () => {
  it('round-trips bytes, including subarray views', async () => {
    const backing = new Uint8Array(1024).map((_, i) => i % 251);
    const view = backing.subarray(100, 600);
    const out = await inflateRaw(await deflateRaw(view));
    expect(Array.from(out)).toEqual(Array.from(view));
  });
});

describe('groupMeshesIntoChunks', () => {
  it('groups by grid cell and never splits a mesh', () => {
    const meshes = [
      mesh(1, [0, 0, 0]),
      mesh(2, [1, 1, 1]),      // same 32m cell as #1
      mesh(3, [1000, 0, 0]),   // far cell
    ];
    const groups = groupMeshesIntoChunks(meshes);
    expect(groups.length).toBe(2);
    const sizes = groups.map((g) => g.length).sort();
    expect(sizes).toEqual([1, 2]);
  });

  it('splits a cell when the soft byte cap is exceeded', () => {
    const meshes = [mesh(1, [0, 0, 0]), mesh(2, [0.5, 0, 0]), mesh(3, [1, 0, 0])];
    // Cap below two records: every mesh lands in its own chunk.
    const groups = groupMeshesIntoChunks(meshes, 10);
    expect(groups.length).toBe(3);
  });
});

describe('v13 geometry section round-trip', () => {
  const meshes = [
    mesh(1, [0, 0, 0]),
    mesh(2, [2, 2, 2], { ifcType: 'IFCSLAB', geometryClass: 2, color: [0, 1, 0, 0.5] }),
    mesh(3, [500, 0, -500], { ifcType: undefined }),
    // No-origin (absolute) mesh: origin must stay undefined after round-trip
    mesh(4, [0, 0, 0], { origin: undefined }),
  ];

  it('round-trips meshes, counts and coordinateInfo (compressed)', async () => {
    const info = coordInfo({ wasmRtcOffset: { x: 1, y: 2, z: 3 }, buildingRotation: 0.25 });
    const section = await buildGeometrySectionV13(meshes, info);
    const result = await readGeometryV13(section, 0, 13);
    expectMeshesEqual(result.meshes, meshes);
    expect(result.totalVertices).toBe(12);
    expect(result.totalTriangles).toBe(4);
    expect(result.coordinateInfo).toEqual(info);
  });

  it('round-trips with compression disabled', async () => {
    const section = await buildGeometrySectionV13(meshes, coordInfo(), { compress: false });
    const result = await readGeometryV13(section, 0, 13);
    expectMeshesEqual(result.meshes, meshes);
  });

  it('exposes a directory with valid AABBs and per-chunk decode', async () => {
    const section = await buildGeometrySectionV13(meshes, coordInfo());
    const open = openGeometryChunksV13(section, 0, 13);
    expect(open.chunks.length).toBeGreaterThanOrEqual(2);
    let total = 0;
    for (let i = 0; i < open.chunks.length; i++) {
      const chunkMeshes = await open.readChunk(i);
      expect(chunkMeshes.length).toBe(open.chunks[i].meshCount);
      total += chunkMeshes.length;
      // Every mesh's anchor lies inside (or on) the chunk AABB.
      const { aabbMin, aabbMax } = open.chunks[i];
      for (const m of chunkMeshes) {
        const ox = m.origin?.[0] ?? 0, oy = m.origin?.[1] ?? 0, oz = m.origin?.[2] ?? 0;
        expect(ox + m.positions[0]).toBeGreaterThanOrEqual(aabbMin[0] - 1e-3);
        expect(ox + m.positions[0]).toBeLessThanOrEqual(aabbMax[0] + 1e-3);
        expect(oy + m.positions[1]).toBeGreaterThanOrEqual(aabbMin[1] - 1e-3);
        expect(oy + m.positions[1]).toBeLessThanOrEqual(aabbMax[1] + 1e-3);
        expect(oz + m.positions[2]).toBeGreaterThanOrEqual(aabbMin[2] - 1e-3);
        expect(oz + m.positions[2]).toBeLessThanOrEqual(aabbMax[2] + 1e-3);
      }
    }
    expect(total).toBe(meshes.length);
  });

  it('small chunks skip compression; a large repetitive chunk compresses', async () => {
    // Small: below the 64KiB floor → raw.
    const small = await buildGeometrySectionV13([mesh(1, [0, 0, 0])], coordInfo());
    const openSmall = openGeometryChunksV13(small, 0, 13);
    expect(openSmall.chunks[0].flags & GeometryChunkFlags.DeflateRaw).toBe(0);

    // Large + repetitive: one 100k-vertex mesh of zeros → compresses well.
    const big = mesh(9, [0, 0, 0], {
      positions: new Float32Array(300_000),
      normals: new Float32Array(300_000),
      indices: new Uint32Array(300_000),
    });
    const section = await buildGeometrySectionV13([big], coordInfo());
    const open = openGeometryChunksV13(section, 0, 13);
    expect(open.chunks[0].flags & GeometryChunkFlags.DeflateRaw).toBe(GeometryChunkFlags.DeflateRaw);
    expect(open.chunks[0].byteLength).toBeLessThan(open.chunks[0].uncompressedLength / 4);
    const decoded = await open.readChunk(0);
    expect(decoded[0].positions.length).toBe(300_000);
  });

  it('handles empty mesh lists', async () => {
    const section = await buildGeometrySectionV13([], coordInfo());
    const result = await readGeometryV13(section, 0, 13);
    expect(result.meshes).toEqual([]);
    expect(result.totalVertices).toBe(0);
  });
});
