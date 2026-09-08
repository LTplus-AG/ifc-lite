/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { countGlbMeshes, parseGLB, parseGLBToMeshData } from './glb.js';

/**
 * Assemble a minimal GLB (12-byte header + JSON chunk + BIN chunk) the same way
 * the Rust assembler does, so we can exercise the empty-export gate without the
 * wasm pipeline.
 */
function buildGlb(json: unknown, bin: Uint8Array = new Uint8Array()): Uint8Array {
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
  dv.setUint32(o, total, true); o += 4; // total length
  // JSON chunk
  dv.setUint32(o, jsonChunkLen, true); o += 4;
  dv.setUint32(o, 0x4e4f534a, true); o += 4; // 'JSON'
  out.set(jsonBytes, o); o += jsonBytes.length;
  for (let i = 0; i < pad4(jsonBytes.length); i++) out[o++] = 0x20; // space-pad JSON
  // BIN chunk (may be zero-length, as it is for an empty export)
  dv.setUint32(o, binChunkLen, true); o += 4;
  dv.setUint32(o, 0x004e4942, true); o += 4; // 'BIN\0'
  out.set(bin, o); o += bin.length;
  return out;
}

describe('countGlbMeshes', () => {
  it('returns 0 for an empty export (meshes: [])', () => {
    const glb = buildGlb({ asset: { version: '2.0' }, meshes: [] });
    expect(countGlbMeshes(glb)).toBe(0);
  });

  it('returns 0 when the meshes array is absent', () => {
    const glb = buildGlb({ asset: { version: '2.0' } });
    expect(countGlbMeshes(glb)).toBe(0);
  });

  it('counts the meshes that are present', () => {
    const glb = buildGlb({ asset: { version: '2.0' }, meshes: [{}, {}, {}] });
    expect(countGlbMeshes(glb)).toBe(3);
  });

  it('returns 0 without throwing on a malformed / non-GLB buffer', () => {
    expect(countGlbMeshes(new Uint8Array(0))).toBe(0);
    expect(countGlbMeshes(new Uint8Array([1, 2, 3]))).toBe(0);
    expect(countGlbMeshes(new Uint8Array([0x67, 0x6c, 0x54, 0x46, 9, 9, 9, 9]))).toBe(0);
  });

  it('parses round-trip with the shared parseGLB', () => {
    const glb = buildGlb({ asset: { version: '2.0' }, meshes: [{}] }, new Uint8Array([1, 2, 3, 4]));
    const { json, bin } = parseGLB(glb);
    expect(json.meshes).toHaveLength(1);
    expect(bin.byteLength).toBe(4);
  });

  it('ignores a chunk appended after the declared total length instead of adopting it as the BIN chunk', () => {
    // A well-formed GLB whose header declares `total` correctly, followed by
    // extra bytes shaped like a legitimate BIN chunk (its own length prefix
    // + 'BIN\0' magic + attacker-controlled payload). The header's `total`
    // field is untouched, so a spec-faithful reader must stop walking chunks
    // there — the genuine BIN chunk must win, not the appended one.
    const legitBin = new Uint8Array([1, 2, 3, 4]);
    const glb = buildGlb({ asset: { version: '2.0' }, meshes: [{}] }, legitBin);
    const evilBin = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
    const trailer = new Uint8Array(8 + evilBin.length);
    const tdv = new DataView(trailer.buffer);
    tdv.setUint32(0, evilBin.length, true);
    tdv.setUint32(4, 0x004e4942, true); // 'BIN\0'
    trailer.set(evilBin, 8);
    const tampered = new Uint8Array(glb.length + trailer.length);
    tampered.set(glb, 0);
    tampered.set(trailer, glb.length);

    const { bin } = parseGLB(tampered);
    expect(Array.from(bin)).toEqual(Array.from(legitBin));
  });

  it('rejects a chunk whose declared length runs past the declared total (no silent truncation)', () => {
    // A chunkLen that overruns `total` must throw, not have `subarray`
    // silently clamp to a truncated (but seemingly valid) BIN buffer.
    const glb = buildGlb({ asset: { version: '2.0' }, meshes: [{}] }, new Uint8Array([1, 2, 3, 4]));
    const dv = new DataView(glb.buffer);
    // BIN chunk's length prefix sits right after the JSON chunk; inflate it
    // far beyond what the (unchanged) header `total` field declares.
    const jsonChunkLen = dv.getUint32(12, true);
    const binLenFieldOffset = 12 + 8 + jsonChunkLen;
    dv.setUint32(binLenFieldOffset, 0xffffff00, true);

    expect(() => parseGLB(glb)).toThrow(/beyond declared length/);
  });
});

describe('parseGLBToMeshData baseColorFactor decode', () => {
  /**
   * Build a minimal single-triangle GLB with one node/mesh/material, matching
   * what the Rust exporter emits: POSITION (VEC3 FLOAT), NORMAL (VEC3 FLOAT),
   * an index accessor (SCALAR UNSIGNED_INT), and a material whose
   * baseColorFactor holds the given linear-light RGBA.
   */
  function buildTriangleGlb(baseColorFactor: [number, number, number, number]): Uint8Array {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const indices = new Uint32Array([0, 1, 2]);

    const posBytes = new Uint8Array(positions.buffer);
    const norBytes = new Uint8Array(normals.buffer);
    const idxBytes = new Uint8Array(indices.buffer);

    const bin = new Uint8Array(posBytes.length + norBytes.length + idxBytes.length);
    let o = 0;
    bin.set(posBytes, o); const posOffset = o; o += posBytes.length;
    bin.set(norBytes, o); const norOffset = o; o += norBytes.length;
    bin.set(idxBytes, o); const idxOffset = o; o += idxBytes.length;

    const json = {
      asset: { version: '2.0' },
      materials: [{ pbrMetallicRoughness: { baseColorFactor } }],
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0, NORMAL: 1 },
              indices: 2,
              material: 0,
            },
          ],
        },
      ],
      nodes: [{ mesh: 0, extras: { expressId: 42 } }],
      bufferViews: [
        { byteOffset: posOffset, byteLength: posBytes.length },
        { byteOffset: norOffset, byteLength: norBytes.length },
        { byteOffset: idxOffset, byteLength: idxBytes.length },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 2, componentType: 5125, count: 3, type: 'SCALAR' },
      ],
    };
    return buildGlb(json, bin);
  }

  it('decodes a linear baseColorFactor back to sRGB, matching the sibling cache reader', () => {
    // 0.2140 is what the exporter writes for an sRGB mid-grey 0.5 channel
    // (IEC 61966-2-1 sRGB->linear). The published `parseGLBToMeshData` path
    // must decode it back to ~0.5, the same way `@ifc-lite/cache`'s
    // `resolveMaterialColor` already does.
    const glb = buildTriangleGlb([0.214, 0.214, 0.214, 1]);
    const [mesh] = parseGLBToMeshData(glb);
    expect(mesh.color[0]).toBeCloseTo(0.5, 3);
    expect(mesh.color[1]).toBeCloseTo(0.5, 3);
    expect(mesh.color[2]).toBeCloseTo(0.5, 3);
    expect(mesh.color[3]).toBe(1); // alpha is not a colour channel, passed through
  });

  it('round-trips black and white exactly', () => {
    const glbBlack = buildTriangleGlb([0, 0, 0, 1]);
    const [black] = parseGLBToMeshData(glbBlack);
    expect(black.color[0]).toBeCloseTo(0, 6);
    expect(black.color[1]).toBeCloseTo(0, 6);
    expect(black.color[2]).toBeCloseTo(0, 6);

    const glbWhite = buildTriangleGlb([1, 1, 1, 1]);
    const [white] = parseGLBToMeshData(glbWhite);
    expect(white.color[0]).toBeCloseTo(1, 6);
    expect(white.color[1]).toBeCloseTo(1, 6);
    expect(white.color[2]).toBeCloseTo(1, 6);
  });
});
