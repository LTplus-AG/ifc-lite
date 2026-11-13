/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reopen lane: with `sharedArena`, a decoded chunk's mesh arrays are copied into
// shared ~1 MiB arena blocks (one allocation per block, not three per mesh). The
// arrays must be the same values, aligned, and independent of each other. By
// default (the published behaviour) every array owns its buffer.
import { describe, expect, it } from 'vitest';
import type { MeshData, CoordinateInfo } from '@ifc-lite/geometry';
import { buildGeometrySectionV13, openGeometryChunksV13 } from './geometry-chunks.js';
import { FORMAT_VERSION } from '../types.js';
import { ArrayArena, BufferReader } from '../utils/buffer-utils.js';

const coordInfo: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  hasLargeCoordinates: false,
};

/** Odd-length type names put every record's arrays at unaligned offsets in the chunk. */
function meshes(): MeshData[] {
  return Array.from({ length: 300 }, (_, i) => {
    const v = 3 + (i % 50);
    return { expressId: i + 1, positions: Float32Array.from({ length: v * 3 }, (_, k) => i + k / 7), normals: new Float32Array(v * 3).fill(i % 3),
      indices: Uint32Array.from({ length: v * 2 }, (_, k) => (k * 5) % v), color: [0.1, 0.2, 0.3, 1], ifcType: 'IfcWall'.slice(0, 3 + (i % 5)) } as MeshData;
  });
}

async function decode(options: { sharedArena?: boolean } = { sharedArena: true }): Promise<MeshData[]> {
  const section = await buildGeometrySectionV13(meshes(), coordInfo, { compress: true });
  const open = openGeometryChunksV13(section, 0, FORMAT_VERSION, options);
  return (await Promise.all(open.chunks.map((_, i) => open.readChunk(i)))).flat();
}

describe('chunk decode arena', () => {
  it('decodes the same arrays, aligned, sharing blocks', async () => {
    const decoded = await decode();
    const byId = new Map(meshes().map((m) => [m.expressId, m]));
    expect(decoded).toHaveLength(300);
    for (const m of decoded) {
      const want = byId.get(m.expressId)!;
      expect([...m.positions]).toEqual([...want.positions]);
      expect([...m.normals]).toEqual([...want.normals]);
      expect([...m.indices]).toEqual([...want.indices]);
      expect(m.positions.byteOffset % 4).toBe(0);
    }
    const buffers = new Set(decoded.flatMap((m) => [m.positions.buffer, m.normals.buffer, m.indices.buffer]));
    expect(buffers.size).toBeLessThan(30); // one block per chunk here; was 900: one ArrayBuffer per array
  });

  it('keeps each mesh\'s arrays independent of the others in its block', async () => {
    const decoded = await decode();
    const before = decoded.map((m) => [m.positions[0], m.normals[0], m.indices[0]].join());
    decoded[0].positions.fill(-1); decoded[0].normals.fill(-1); decoded[0].indices.fill(0xffffffff);
    expect(decoded.slice(1).map((m) => [m.positions[0], m.normals[0], m.indices[0]].join())).toEqual(before.slice(1));
  });

  it('by default, every mesh array owns its buffer (as published before the arena)', async () => {
    const decoded = await decode({});
    for (const m of decoded) for (const a of [m.positions, m.normals, m.indices]) {
      expect(a.byteOffset).toBe(0);
      expect(a.buffer.byteLength).toBe(a.byteLength);
    }
    expect(new Set(decoded.flatMap((m) => [m.positions.buffer, m.normals.buffer, m.indices.buffer])).size).toBe(900);
  });

  it('by default, transferring one mesh\'s buffers to a worker leaves every other mesh intact', async () => {
    const decoded = await decode({});
    const before = decoded.slice(1).map((m) => [[...m.positions].join(), [...m.normals].join(), [...m.indices].join()].join('|'));
    const first = decoded[0];
    structuredClone(first, { transfer: [first.positions.buffer, first.normals.buffer, first.indices.buffer] as ArrayBuffer[] });
    expect(first.positions.length).toBe(0); // detached: it moved to the "worker"
    expect(decoded.slice(1).map((m) => [[...m.positions].join(), [...m.normals].join(), [...m.indices].join()].join('|'))).toEqual(before);
  });

  it('a small chunk keeps a block no larger than its own arrays, not a full ~1 MiB block (review)', async () => {
    const small: MeshData[] = [{ expressId: 1, positions: new Float32Array(9).fill(1), normals: new Float32Array(9).fill(0.5),
      indices: Uint32Array.from([0, 1, 2]), color: [0.1, 0.2, 0.3, 1], ifcType: 'IfcWall' } as MeshData];
    const section = await buildGeometrySectionV13(small, coordInfo, { compress: false });
    const open = openGeometryChunksV13(section, 0, FORMAT_VERSION, { sharedArena: true });
    const [mesh] = await open.readChunk(0);
    expect(mesh.positions.buffer).toBe(mesh.indices.buffer); // still one shared block
    expect(mesh.positions.buffer.byteLength).toBeLessThanOrEqual(open.chunks[0].uncompressedLength);
    expect([...mesh.positions]).toEqual([...small[0].positions]);
  });

  it('an arena sizes each new block to what the caller still expects, at least the request and at most ~1 MiB', () => {
    const arena = new ArrayArena(100);
    arena.take(40);
    expect(arena.buffer!.byteLength).toBe(100);
    arena.take(60);
    expect(arena.buffer!.byteLength).toBe(100); // the same block
    arena.take(8); // past the hint: a block just large enough
    expect(arena.buffer!.byteLength).toBe(8);
    const unbounded = new ArrayArena();
    unbounded.take(4);
    expect(unbounded.buffer!.byteLength).toBe(1 << 20);
  });

  it('gives a large array its own buffer, and a plain reader still copies each array', () => {
    const reader = new BufferReader(new Float32Array(10).buffer);
    const a = reader.readFloat32Array(5), b = reader.readFloat32Array(5);
    expect(a.buffer).not.toBe(b.buffer);
  });
});
