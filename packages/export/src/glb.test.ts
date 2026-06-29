/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { countGlbMeshes, parseGLB } from './glb.js';

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
});
