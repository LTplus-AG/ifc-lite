/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `glb.ts` exports four functions; `glb.test.ts` covered exactly one
 * (`countGlbMeshes`) plus a one-line smoke of `parseGLB`. `extractGlbMapping`
 * and `parseGLBToMeshData` — the two that actually read binary offsets — had
 * no test of their own, and a mutation sweep confirmed it: swapping the node
 * and mesh indices in the mapping, dropping the accessor `byteOffset` from the
 * buffer-view base, forcing material alpha to 1, blackening the default colour,
 * and deleting the GLB total-length check ALL left the suite green.
 *
 * A wrong accessor offset does not throw — it reads the neighbouring
 * attribute's bytes and hands back a mesh whose normals are its positions.
 * These are the tests that see it.
 */

import { describe, it, expect } from 'vitest';
import { parseGLB, extractGlbMapping, parseGLBToMeshData, countGlbMeshes } from './glb.js';

const FLOAT = 5126;
const UNSIGNED_INT = 5125;

/** Assemble a GLB from a JSON chunk and a BIN chunk, as the Rust assembler does. */
function buildGlb(json: unknown, bin: Uint8Array, declaredTotalLength?: number): Uint8Array {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad4 = (n: number) => (4 - (n % 4)) % 4;
  const jsonChunkLen = jsonBytes.length + pad4(jsonBytes.length);
  const binChunkLen = bin.length + pad4(bin.length);
  const total = 12 + 8 + jsonChunkLen + 8 + binChunkLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let o = 0;
  dv.setUint32(o, 0x46546c67, true); o += 4; // magic 'glTF'
  dv.setUint32(o, 2, true); o += 4; // version
  dv.setUint32(o, declaredTotalLength ?? total, true); o += 4;
  dv.setUint32(o, jsonChunkLen, true); o += 4;
  dv.setUint32(o, 0x4e4f534a, true); o += 4; // 'JSON'
  out.set(jsonBytes, o); o += jsonBytes.length;
  for (let i = 0; i < pad4(jsonBytes.length); i++) out[o++] = 0x20;
  dv.setUint32(o, binChunkLen, true); o += 4;
  dv.setUint32(o, 0x004e4942, true); o += 4; // 'BIN\0'
  out.set(bin, o);
  return out;
}

const POSITIONS = [0, 0, 0, 1, 0, 0, 1, 1, 0];
/**
 * Deliberately DIFFERENT from POSITIONS, and not a unit axis triple: if the
 * accessor byteOffset were dropped, NORMAL would silently alias POSITION and a
 * fixture whose normals happened to equal its positions would never notice.
 */
const NORMALS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const INDICES = [0, 1, 2];

/** BIN chunk: 16 bytes of lead-in (→ bufferView byteOffset 16), then the three
 *  accessor ranges back to back at accessor byteOffsets 0 / 36 / 72. */
function buildBin(): { bin: Uint8Array; bvOffset: number; accOffsets: [number, number, number] } {
  const bvOffset = 16;
  const posBytes = new Uint8Array(new Float32Array(POSITIONS).buffer);
  const norBytes = new Uint8Array(new Float32Array(NORMALS).buffer);
  const idxBytes = new Uint8Array(new Uint32Array(INDICES).buffer);
  const bin = new Uint8Array(bvOffset + posBytes.length + norBytes.length + idxBytes.length);
  bin.fill(0xff, 0, bvOffset); // lead-in is NOT zero, so aliasing it is visible
  bin.set(posBytes, bvOffset);
  bin.set(norBytes, bvOffset + posBytes.length);
  bin.set(idxBytes, bvOffset + posBytes.length + norBytes.length);
  return {
    bin,
    bvOffset,
    accOffsets: [0, posBytes.length, posBytes.length + norBytes.length],
  };
}

/**
 * A GLB with TWO nodes but ONE mesh: node 0 carries no mesh at all, so the
 * node index (1) and the mesh index (0) DIFFER. Equal indices would make
 * `{ node, mesh }` a symmetric pair that a swap cannot be seen through.
 */
function buildMeshGlb(options: { material?: number; expressId?: number } = {}): Uint8Array {
  const { bin, bvOffset, accOffsets } = buildBin();
  const json: Record<string, unknown> = {
    asset: { version: '2.0' },
    nodes: [
      { name: 'no-mesh-node' },
      {
        mesh: 0,
        extras: options.expressId === undefined ? {} : { expressId: options.expressId },
      },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1 },
            indices: 2,
            ...(options.material === undefined ? {} : { material: options.material }),
          },
        ],
      },
    ],
    accessors: [
      { bufferView: 0, byteOffset: accOffsets[0], componentType: FLOAT, count: 3, type: 'VEC3' },
      { bufferView: 0, byteOffset: accOffsets[1], componentType: FLOAT, count: 3, type: 'VEC3' },
      { bufferView: 0, byteOffset: accOffsets[2], componentType: UNSIGNED_INT, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: bvOffset, byteLength: bin.length - bvOffset }],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [0.2, 0.4, 0.6, 0.5] } },
      { pbrMetallicRoughness: { baseColorFactor: [0.1, 0.3, 0.5] } }, // RGB only
      { pbrMetallicRoughness: {} }, // no factor at all
    ],
    buffers: [{ byteLength: bin.length }],
  };
  return buildGlb(json, bin);
}

describe('extractGlbMapping', () => {
  it('maps each express id to its own node index and its own mesh index', () => {
    // node 1 → mesh 0: the two indices differ, so a swap is visible.
    const mapping = extractGlbMapping(buildMeshGlb({ expressId: 42 }));
    expect(mapping).toEqual({ '42': { node: 1, mesh: 0 } });
  });

  it('skips a node that has no mesh and a node that has no express id', () => {
    const withoutId = extractGlbMapping(buildMeshGlb());
    expect(withoutId).toEqual({});
  });
});

describe('parseGLBToMeshData', () => {
  it('reads each attribute from its own accessor byteOffset, not the buffer-view base', () => {
    const meshes = parseGLBToMeshData(buildMeshGlb({ expressId: 42 }));
    expect(meshes).toHaveLength(1);
    expect(Array.from(meshes[0].positions)).toEqual(POSITIONS);
    // If the accessor byteOffset were dropped, this would come back as
    // POSITIONS (or as the 0xff lead-in bytes read as floats).
    expect(Array.from(meshes[0].normals).map((v) => Number(v.toFixed(6)))).toEqual(NORMALS);
    expect(Array.from(meshes[0].indices)).toEqual(INDICES);
  });

  it('carries the node expressId onto the mesh, defaulting to 0 when absent', () => {
    expect(parseGLBToMeshData(buildMeshGlb({ expressId: 42 }))[0].expressId).toBe(42);
    expect(parseGLBToMeshData(buildMeshGlb())[0].expressId).toBe(0);
  });

  it('resolves the material baseColorFactor including a non-1 alpha', () => {
    // Alpha 0.5: an opaque fixture makes the alpha slot an identity against
    // the hard-coded 1 fallback and cannot see it being dropped.
    const meshes = parseGLBToMeshData(buildMeshGlb({ material: 0, expressId: 42 }));
    expect(meshes[0].color).toEqual([0.2, 0.4, 0.6, 0.5]);
  });

  it('defaults alpha to 1 for an RGB-only baseColorFactor', () => {
    const meshes = parseGLBToMeshData(buildMeshGlb({ material: 1, expressId: 42 }));
    expect(meshes[0].color).toEqual([0.1, 0.3, 0.5, 1]);
  });

  it('falls back to the neutral grey default when the primitive names no material', () => {
    // The third, untested state alongside "has a factor" and "has an RGB
    // factor": no material index at all.
    const meshes = parseGLBToMeshData(buildMeshGlb({ expressId: 42 }));
    expect(meshes[0].color).toEqual([0.8, 0.8, 0.8, 1]);
  });

  it('falls back to the neutral grey default when the material carries no baseColorFactor', () => {
    const meshes = parseGLBToMeshData(buildMeshGlb({ material: 2, expressId: 42 }));
    expect(meshes[0].color).toEqual([0.8, 0.8, 0.8, 1]);
  });

  it('returns no meshes for a node-less GLB', () => {
    const glb = buildGlb({ asset: { version: '2.0' }, meshes: [] }, new Uint8Array(4));
    expect(parseGLBToMeshData(glb)).toEqual([]);
  });

  /**
   * `readAccessor`'s bounds check (`byteOffset + byteLen > bin.byteLength`)
   * is a bare comparison. `count` used to be computed as
   * `Number(acc.count || 0)`, which only substitutes 0 for a MISSING count —
   * a present-but-non-numeric count (a corrupted JSON chunk with
   * `"count":"abc"`) survives `|| 0` and becomes NaN. `NaN > bin.byteLength`
   * is `false`, so the guard was silently bypassed and `bin.subarray(offset,
   * NaN)` returned an EMPTY view: the mesh decoded with zero
   * vertices/indices instead of the read failing loudly.
   */
  it('rejects a non-numeric accessor.count instead of silently decoding an empty mesh', () => {
    // Same shape as buildMeshGlb, but the POSITION accessor's `count` is a
    // non-empty, non-numeric string. `Number(acc.count || 0)` only
    // substitutes a default for a MISSING count -- a present-but-bogus
    // count like this survives `|| 0` and becomes NaN.
    const { bin, bvOffset, accOffsets } = buildBin();
    const json = {
      asset: { version: '2.0' },
      nodes: [{ mesh: 0, extras: { expressId: 42 } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
      accessors: [
        { bufferView: 0, byteOffset: accOffsets[0], componentType: FLOAT, count: 'abc', type: 'VEC3' },
        { bufferView: 0, byteOffset: accOffsets[1], componentType: FLOAT, count: 3, type: 'VEC3' },
        { bufferView: 0, byteOffset: accOffsets[2], componentType: UNSIGNED_INT, count: 3, type: 'SCALAR' },
      ],
      bufferViews: [{ buffer: 0, byteOffset: bvOffset, byteLength: bin.length - bvOffset }],
      buffers: [{ byteLength: bin.length }],
    };
    const glb = buildGlb(json, bin);
    expect(() => parseGLBToMeshData(glb)).toThrow(/invalid count/);
  });

  it('still decodes a valid accessor.count (bounding control: the untampered GLB still works)', () => {
    const meshes = parseGLBToMeshData(buildMeshGlb({ expressId: 42 }));
    expect(meshes).toHaveLength(1);
    expect(Array.from(meshes[0].positions)).toEqual(POSITIONS);
  });

  /**
   * `Number.isInteger(count) && count >= 0` must accept the boundary value
   * `0`, not just positive counts -- a legitimately empty accessor (all
   * three of POSITION/NORMAL/indices declaring zero elements) is not a
   * malformed GLB and must decode to a mesh with empty typed arrays rather
   * than being rejected by the new guard.
   */
  it('still decodes a valid accessor.count = 0 (bounding control: an empty-but-declared accessor is not an error)', () => {
    const bin = new Uint8Array(0);
    const json = {
      asset: { version: '2.0' },
      nodes: [{ mesh: 0, extras: { expressId: 42 } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
      accessors: [
        { bufferView: 0, byteOffset: 0, componentType: FLOAT, count: 0, type: 'VEC3' },
        { bufferView: 0, byteOffset: 0, componentType: FLOAT, count: 0, type: 'VEC3' },
        { bufferView: 0, byteOffset: 0, componentType: UNSIGNED_INT, count: 0, type: 'SCALAR' },
      ],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 0 }],
      buffers: [{ byteLength: 0 }],
    };
    const glb = buildGlb(json, bin);
    const meshes = parseGLBToMeshData(glb);
    expect(meshes).toHaveLength(1);
    expect(meshes[0].positions).toHaveLength(0);
    expect(meshes[0].normals).toHaveLength(0);
    expect(meshes[0].indices).toHaveLength(0);
  });
});

describe('parseGLB header validation', () => {
  it('rejects a GLB whose declared total length exceeds the buffer it arrived in', () => {
    // A truncated download: the chunks that DID arrive still parse, so without
    // the length check the caller silently accepts a partial model.
    const { bin } = buildBin();
    const truncated = buildGlb({ asset: { version: '2.0' }, meshes: [{}] }, bin, 1_000_000);
    expect(() => parseGLB(truncated)).toThrow(/Invalid GLB length/);
    expect(countGlbMeshes(truncated)).toBe(0);
  });

  it('accepts the same GLB when the declared length matches', () => {
    const { bin } = buildBin();
    const intact = buildGlb({ asset: { version: '2.0' }, meshes: [{}] }, bin);
    expect(countGlbMeshes(intact)).toBe(1);
  });
});
