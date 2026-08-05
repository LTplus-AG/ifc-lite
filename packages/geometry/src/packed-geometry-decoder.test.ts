/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Packed geometry cache shard decoder.
 *
 * The shard is produced by the native Rust pipeline and consumed by
 * `native-bridge.ts`; a stride or offset disagreement between the two ends is
 * silent — the renderer just draws the wrong vertices onto the wrong element.
 * The fixture below is written from the FORMAT SPEC (the layout documented on
 * `decodePackedGeometryCacheShard`), not from the decoder, so the two are
 * independent statements of the same contract.
 */

import { describe, it, expect } from 'vitest';

import {
  decodePackedGeometryCacheShard,
  toArrayBuffer,
} from './packed-geometry-decoder.js';

const MAGIC = 0x49464342;
const HEADER_WORDS = 8;
const MESH_RECORD_WORDS = 11;

interface MeshRecord {
  expressId: number;
  posOff: number;
  posLen: number;
  nrmOff: number;
  nrmLen: number;
  idxOff: number;
  idxLen: number;
  color: [number, number, number, number];
}

/** Independent encoder, written from the documented layout. */
function encodeShard(opts: {
  magic?: number;
  version?: number;
  processed?: number;
  total?: number;
  meshes: MeshRecord[];
  positions: number[];
  normals: number[];
  indices: number[];
}): Uint8Array {
  const { meshes, positions, normals, indices } = opts;
  const headerBytes = HEADER_WORDS * 4;
  const tableBytes = meshes.length * MESH_RECORD_WORDS * 4;
  const dataBytes = (positions.length + normals.length + indices.length) * 4;
  const buf = new ArrayBuffer(headerBytes + tableBytes + dataBytes);
  const view = new DataView(buf);

  const header = [
    opts.magic ?? MAGIC,
    opts.version ?? 1,
    meshes.length,
    positions.length,
    normals.length,
    indices.length,
    opts.processed ?? 0,
    opts.total ?? 0,
  ];
  header.forEach((w, i) => view.setUint32(i * 4, w, true));

  meshes.forEach((m, i) => {
    const base = headerBytes + i * MESH_RECORD_WORDS * 4;
    view.setUint32(base, m.expressId, true);
    view.setUint32(base + 4, m.posOff, true);
    view.setUint32(base + 8, m.posLen, true);
    view.setUint32(base + 12, m.nrmOff, true);
    view.setUint32(base + 16, m.nrmLen, true);
    view.setUint32(base + 20, m.idxOff, true);
    view.setUint32(base + 24, m.idxLen, true);
    m.color.forEach((c, k) => view.setFloat32(base + 28 + k * 4, c, true));
  });

  let cursor = headerBytes + tableBytes;
  positions.forEach((v) => {
    view.setFloat32(cursor, v, true);
    cursor += 4;
  });
  normals.forEach((v) => {
    view.setFloat32(cursor, v, true);
    cursor += 4;
  });
  indices.forEach((v) => {
    view.setUint32(cursor, v, true);
    cursor += 4;
  });

  return new Uint8Array(buf);
}

// Two meshes with DIFFERENT, non-zero pool offsets and DIFFERENT lengths, so
// neither the mesh-table stride nor the positions/normals/indices section
// offsets can be got right by accident. Values are distinguishable per slot.
const POSITIONS = [
  1, 2, 3, 4, 5, 6, // mesh A (2 verts)
  10, 20, 30, 40, 50, 60, 70, 80, 90, // mesh B (3 verts)
];
const NORMALS = [
  0, 0, 1, 0, 1, 0, // mesh A
  1, 0, 0, 0, 0, -1, 0, -1, 0, // mesh B
];
const INDICES = [0, 1, 0, /* mesh A */ 0, 1, 2 /* mesh B */];

const FIXTURE = encodeShard({
  processed: 7,
  total: 42,
  meshes: [
    {
      expressId: 101,
      posOff: 0,
      posLen: 6,
      nrmOff: 0,
      nrmLen: 6,
      idxOff: 0,
      idxLen: 3,
      color: [0.25, 0.5, 0.75, 1],
    },
    {
      expressId: 202,
      posOff: 6,
      posLen: 9,
      nrmOff: 6,
      nrmLen: 9,
      idxOff: 3,
      idxLen: 3,
      color: [1, 0, 0.5, 0.25],
    },
  ],
  positions: POSITIONS,
  normals: NORMALS,
  indices: INDICES,
});

describe('toArrayBuffer', () => {
  it('returns an ArrayBuffer payload unchanged', () => {
    const ab = new ArrayBuffer(8);
    expect(toArrayBuffer(ab)).toBe(ab);
  });

  it('unwraps a whole-buffer Uint8Array without copying', () => {
    const u8 = new Uint8Array([1, 2, 3, 4]);
    expect(toArrayBuffer(u8)).toBe(u8.buffer);
  });

  it('copies a Uint8Array that is only a window onto its buffer', () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const window = backing.subarray(2, 6);

    const out = toArrayBuffer(window);

    expect(out).not.toBe(backing.buffer);
    expect(out.byteLength).toBe(4);
    expect(Array.from(new Uint8Array(out))).toEqual([3, 4, 5, 6]);
  });

  it('accepts a plain number array', () => {
    expect(Array.from(new Uint8Array(toArrayBuffer([9, 8, 7])))).toEqual([9, 8, 7]);
  });

  it('rejects an unsupported payload', () => {
    expect(() => toArrayBuffer('nope')).toThrow(/Unsupported packed geometry shard payload/);
  });
});

describe('decodePackedGeometryCacheShard', () => {
  it('splits the pools at the documented mesh-table stride and section offsets', () => {
    const batch = decodePackedGeometryCacheShard(FIXTURE, 1234, 5);

    expect(batch.meshes).toHaveLength(2);

    const [a, b] = batch.meshes;
    expect(a.expressId).toBe(101);
    expect(Array.from(a.positions)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Array.from(a.normals)).toEqual([0, 0, 1, 0, 1, 0]);
    expect(Array.from(a.indices)).toEqual([0, 1, 0]);
    expect(a.color).toEqual([0.25, 0.5, 0.75, 1]);

    // Mesh B reads from a non-zero offset in every pool AND has a different
    // length from mesh A, so a wrong stride or a collapsed section offset
    // cannot produce these values.
    expect(b.expressId).toBe(202);
    expect(Array.from(b.positions)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(Array.from(b.normals)).toEqual([1, 0, 0, 0, 0, -1, 0, -1, 0]);
    expect(Array.from(b.indices)).toEqual([0, 1, 2]);
    expect(b.color).toEqual([1, 0, 0.5, 0.25]);
  });

  it('carries the progress counters and native telemetry', () => {
    const batch = decodePackedGeometryCacheShard(FIXTURE, 1234, 5);

    expect(batch.progress).toEqual({ processed: 7, total: 42, currentType: 'cached' });
    expect(batch.nativeTelemetry).toMatchObject({
      batchSequence: 5,
      payloadKind: 'packed-cache-shard',
      meshCount: 2,
      positionsLen: POSITIONS.length,
      normalsLen: NORMALS.length,
      indicesLen: INDICES.length,
      jsReceivedTimeMs: 1234,
    });
  });

  it('decodes an empty shard', () => {
    const empty = encodeShard({ meshes: [], positions: [], normals: [], indices: [] });

    const batch = decodePackedGeometryCacheShard(empty, 0, 0);

    expect(batch.meshes).toEqual([]);
    expect(batch.progress.total).toBe(0);
  });

  it('rejects a payload whose magic is not the shard magic', () => {
    const bad = encodeShard({
      magic: 0xdeadbeef,
      meshes: [],
      positions: [],
      normals: [],
      indices: [],
    });

    expect(() => decodePackedGeometryCacheShard(bad, 0, 0)).toThrow(
      /Invalid packed geometry cache shard magic/
    );
  });

  it('rejects an unsupported format version', () => {
    const bad = encodeShard({
      version: 2,
      meshes: [],
      positions: [],
      normals: [],
      indices: [],
    });

    expect(() => decodePackedGeometryCacheShard(bad, 0, 0)).toThrow(
      /Unsupported packed geometry cache shard version: 2/
    );
  });
});
