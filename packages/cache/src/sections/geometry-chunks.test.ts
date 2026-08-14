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
  decodeGeometryChunk,
} from './geometry-chunks.js';
import { GeometryChunkFlags, type GeometryChunkInfo } from '../types.js';

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

describe('corrupt geometry chunk directory', () => {
  // A chunk record's byteOffset/byteLength are external, on-disk declared
  // values (like a mesh's pool offset/length in the packed-geometry format).
  // `Uint8Array.subarray` SATURATES instead of throwing when a range runs
  // past the buffer, and `decodeGeometryChunk`'s own uncompressedLength
  // check can be neutralised by lying about uncompressedLength AND meshCount
  // to match whatever bytes the corrupted byteLength actually reaches —
  // silently letting one chunk absorb a NEIGHBOURING chunk's real mesh
  // records instead of erroring. Directory-level validation closes this
  // independent of anything the corrupted entry itself claims.

  // Locate a chunk's 44-byte directory entry by its known (byteOffset,
  // byteLength) pair, so tests don't have to hand-derive the header layout.
  function findDirectoryEntry(bytes: Uint8Array, byteOffset: number, byteLength: number): number {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let o = 0; o + 44 <= bytes.byteLength; o += 1) {
      if (dv.getUint32(o + 24, true) === byteOffset && dv.getUint32(o + 28, true) === byteLength) {
        return o;
      }
    }
    throw new Error('directory entry not found');
  }

  it('rejects a chunk whose declared range overruns the buffer', async () => {
    const meshes = [mesh(1, [0, 0, 0]), mesh(2, [5000, 5000, 5000])]; // forced into separate chunks
    const section = await buildGeometrySectionV13(meshes, coordInfo(), { compress: false });
    const bytes = new Uint8Array(section);
    const info0 = openGeometryChunksV13(section, 0, 13).chunks[0];
    const entry = findDirectoryEntry(bytes, info0.byteOffset, info0.byteLength);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    dv.setUint32(entry + 28, info0.byteLength + 10_000, true); // byteLength: reach past the buffer end

    expect(() => openGeometryChunksV13(section, 0, 13)).toThrow(/not contiguous/);
  });

  it('rejects a chunk whose inflated byteLength/meshCount/uncompressedLength consistently absorb the next chunk', async () => {
    const meshes = [mesh(1, [0, 0, 0]), mesh(2, [5000, 5000, 5000])];
    const section = await buildGeometrySectionV13(meshes, coordInfo(), { compress: false });
    const bytes = new Uint8Array(section);
    const open = openGeometryChunksV13(section, 0, 13);
    expect(open.chunks.length).toBe(2); // control: the fixture really did split into 2 chunks
    const info0 = open.chunks[0];
    const info1 = open.chunks[1];
    const entry = findDirectoryEntry(bytes, info0.byteOffset, info0.byteLength);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Extend chunk 0 to reach exactly to chunk 1's end (absorbing chunk 1's
    // real bytes in full), and lie about uncompressedLength/meshCount to
    // match — every *local* consistency check on this one entry passes.
    const absorbedLength = info1.byteOffset + info1.byteLength - info0.byteOffset;
    dv.setUint32(entry + 28, absorbedLength, true); // byteLength
    dv.setUint32(entry + 32, absorbedLength, true); // uncompressedLength
    dv.setUint32(entry + 36, info0.meshCount + info1.meshCount, true); // meshCount

    expect(() => openGeometryChunksV13(section, 0, 13)).toThrow(/not contiguous/);
  });

  it('bounding control: a valid multi-chunk directory (ranges reaching exactly to the next chunk) still decodes', async () => {
    const meshes = [mesh(1, [0, 0, 0]), mesh(2, [5000, 5000, 5000])];
    const section = await buildGeometrySectionV13(meshes, coordInfo(), { compress: false });
    const open = openGeometryChunksV13(section, 0, 13);
    expect(open.chunks.length).toBe(2);
    const decoded0 = await open.readChunk(0);
    const decoded1 = await open.readChunk(1);
    expect([...decoded0, ...decoded1].map((m) => m.expressId).sort()).toEqual([1, 2]);
  });

  // The three tests above all validate an element against its PREDECESSOR.
  // That can never anchor element 0, so a directory whose offsets are all
  // shifted by the SAME amount stays perfectly contiguous and passes every
  // one of them. `headLength` is the external anchor.
  it('rejects a directory whose offsets are all shifted by the same amount (contiguous, but starting in the wrong place)', async () => {
    const meshes = [mesh(1, [0, 0, 0]), mesh(2, [5000, 5000, 5000])];
    const section = await buildGeometrySectionV13(meshes, coordInfo(), { compress: false });
    const bytes = new Uint8Array(section);
    const open = openGeometryChunksV13(section, 0, 13);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    // Shift EVERY chunk's byteOffset by the same delta. Relative spacing —
    // and therefore contiguity — is untouched.
    const SHIFT = 8;
    for (const info of open.chunks) {
      const entry = findDirectoryEntry(bytes, info.byteOffset, info.byteLength);
      dv.setUint32(entry + 24, info.byteOffset + SHIFT, true);
    }

    expect(() => openGeometryChunksV13(section, 0, 13)).toThrow(
      /chunk 0 byteOffset .* does not start at the end of the head/,
    );
  });

  // The chunk-0 anchor above is *computed from* `head.headLength`, itself an
  // on-disk declared field. The check `chunks[0].byteOffset === 4 +
  // head.headLength` only cross-validates two independently-corruptible
  // fields against EACH OTHER — never against where the head parse actually
  // landed (reader.position). So corrupting headLength and echoing the same
  // corruption into chunk 0's declared byteOffset keeps the two "consistent"
  // and sails through, even though neither matches the true head size.
  it('rejects a headLength that disagrees with the actual parsed head size, even when chunk 0 is forged to match it', async () => {
    const meshes = [mesh(1, [0, 0, 0])];
    const section = await buildGeometrySectionV13(meshes, coordInfo(), { compress: false });
    const bytes = new Uint8Array(section);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const open = openGeometryChunksV13(section, 0, 13);
    const info0 = open.chunks[0];
    const trueHeadLength = dv.getUint32(0, true);
    const entry = findDirectoryEntry(bytes, info0.byteOffset, info0.byteLength);

    // Shrink the declared headLength by 4 bytes, and move chunk 0's declared
    // byteOffset to match the new (wrong) anchor consistently.
    const forgedHeadLength = trueHeadLength - 4;
    dv.setUint32(0, forgedHeadLength, true);
    dv.setUint32(entry + 24, 4 + forgedHeadLength, true);

    expect(() => openGeometryChunksV13(section, 0, 13)).toThrow(/headLength/);
  });

  // `readChunk`'s own end-of-buffer check was unreachable from the tests
  // above: enlarging chunk 0 breaks contiguity, so `openGeometryChunksV13`
  // throws first and the guard never runs. Enlarging the LAST chunk leaves
  // contiguity intact (it has no successor to disagree with), so this is the
  // shape that actually exercises it.
  it('rejects a LAST chunk whose declared range runs past the buffer (reaches readChunk, not the directory check)', async () => {
    const meshes = [mesh(1, [0, 0, 0]), mesh(2, [5000, 5000, 5000])];
    const section = await buildGeometrySectionV13(meshes, coordInfo(), { compress: false });
    const bytes = new Uint8Array(section);
    const open = openGeometryChunksV13(section, 0, 13);
    const last = open.chunks[open.chunks.length - 1];
    const entry = findDirectoryEntry(bytes, last.byteOffset, last.byteLength);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    dv.setUint32(entry + 28, last.byteLength + 10_000, true);

    // The directory still validates: chunk 0 is anchored, and the last chunk
    // has no successor for the contiguity loop to compare against.
    const reopened = openGeometryChunksV13(section, 0, 13);
    await expect(reopened.readChunk(open.chunks.length - 1)).rejects.toThrow(
      /exceeds buffer length/,
    );
  });
});

describe('decodeGeometryChunk length verification', () => {
  // Mutation testing showed this guard's reject path was asserted nowhere:
  // deleting the `raw.byteLength !== info.uncompressedLength` check in
  // decodeGeometryChunk left the full suite green. A directory entry that
  // lies about a chunk's decoded length (truncation, corruption, or a
  // writer/reader offset drift) must fail loudly instead of silently
  // handing the decoder a short/long mesh-record stream it would then
  // mis-parse into garbage vertex/index data.
  it('throws when the stored bytes decode to a length that disagrees with the directory', async () => {
    const meshes = [mesh(1, [0, 0, 0])];
    const section = await buildGeometrySectionV13(meshes, coordInfo(), { compress: false });
    const open = openGeometryChunksV13(section, 0, 13);
    const realInfo = open.chunks[0];
    expect(realInfo.flags & GeometryChunkFlags.DeflateRaw).toBe(0); // uncompressed: raw === stored

    const bytes = new Uint8Array(section);
    const stored = bytes.subarray(realInfo.byteOffset, realInfo.byteOffset + realInfo.byteLength);

    // Directory claims one more byte than the record actually decodes to.
    const lyingInfo: GeometryChunkInfo = { ...realInfo, uncompressedLength: realInfo.uncompressedLength + 1 };
    await expect(decodeGeometryChunk(stored, lyingInfo, 13)).rejects.toThrow(
      /Invalid cache: chunk decoded to \d+ bytes, directory says \d+/,
    );

    // Control: the real (truthful) info round-trips fine — the throw above is
    // caused by the lie, not some unrelated failure in the fixture. Assert
    // the decoded content itself (mesh count + expressId), not mere
    // truthiness: an empty array is also truthy and would satisfy a
    // `resolves.toBeTruthy()` check whether or not any mesh actually decoded.
    const decoded = await decodeGeometryChunk(stored, realInfo, 13);
    expectMeshesEqual(decoded, meshes);
  });
});
