/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { parseGLBToMeshData, loadGLBToMeshData } from './glb.js';

/**
 * Build a minimal valid GLB (binary glTF) by hand. Mirrors the structure
 * that `GLTFExporter` in `@ifc-lite/export` produces (one mesh per node,
 * one material per node, KHR_materials_unlit) without adding a cross-
 * package test dependency on `@ifc-lite/export`.
 */
function buildGLB(materials: Array<[number, number, number, number]>): Uint8Array {
  // One triangle per material; each lives on its own node referencing its
  // own material so the material→colour resolution can be checked per node.
  const triCount = materials.length;
  const verts = new Float32Array(triCount * 9);    // 3 verts × 3 floats
  const norms = new Float32Array(triCount * 9);
  const idx = new Uint32Array(triCount * 3);

  for (let i = 0; i < triCount; i++) {
    const v = i * 9;
    verts.set([0, 0, 0, 1, 0, 0, 0, 1, 0], v);
    norms.set([0, 0, 1, 0, 0, 1, 0, 0, 1], v);
    idx.set([i * 3, i * 3 + 1, i * 3 + 2], i * 3);
  }

  const posBytes = new Uint8Array(verts.buffer);
  const normBytes = new Uint8Array(norms.buffer);
  const idxBytes = new Uint8Array(idx.buffer);

  const accessors: any[] = [];
  const primitives: any[] = [];
  const meshes: any[] = [];
  const nodes: any[] = [];

  for (let i = 0; i < triCount; i++) {
    const posIdx = accessors.length;
    accessors.push({
      bufferView: 0,
      byteOffset: i * 9 * 4,
      componentType: 5126,
      count: 3,
      type: 'VEC3',
      min: [0, 0, 0],
      max: [1, 1, 0],
    });
    const normIdx = accessors.length;
    accessors.push({
      bufferView: 1,
      byteOffset: i * 9 * 4,
      componentType: 5126,
      count: 3,
      type: 'VEC3',
    });
    const idxAccIdx = accessors.length;
    accessors.push({
      bufferView: 2,
      byteOffset: i * 3 * 4,
      componentType: 5125,
      count: 3,
      type: 'SCALAR',
    });

    meshes.push({
      primitives: [
        {
          attributes: { POSITION: posIdx, NORMAL: normIdx },
          indices: idxAccIdx,
          material: i,
        },
      ],
    });
    nodes.push({ mesh: i, extras: { expressId: 100 + i } });
  }

  const json = {
    asset: { version: '2.0', generator: 'test' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials: materials.map((c) => ({
      pbrMetallicRoughness: {
        baseColorFactor: c,
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      extensions: { KHR_materials_unlit: {} },
      ...(c[3] < 1 ? { alphaMode: 'BLEND' as const } : {}),
    })),
    accessors,
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes.byteLength, byteStride: 12, target: 34962 },
      {
        buffer: 0,
        byteOffset: posBytes.byteLength,
        byteLength: normBytes.byteLength,
        byteStride: 12,
        target: 34962,
      },
      {
        buffer: 0,
        byteOffset: posBytes.byteLength + normBytes.byteLength,
        byteLength: idxBytes.byteLength,
        target: 34963,
      },
    ],
    buffers: [
      {
        byteLength: posBytes.byteLength + normBytes.byteLength + idxBytes.byteLength,
      },
    ],
  };

  const jsonStr = JSON.stringify(json);
  const jsonBuf = new TextEncoder().encode(jsonStr);
  const jsonPad = (4 - (jsonBuf.byteLength % 4)) % 4;
  const jsonChunkLen = jsonBuf.byteLength + jsonPad;

  const binLen = posBytes.byteLength + normBytes.byteLength + idxBytes.byteLength;
  const binPad = (4 - (binLen % 4)) % 4;
  const binChunkLen = binLen + binPad;

  const total = 12 + 8 + jsonChunkLen + 8 + binChunkLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); // glTF
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonChunkLen, true);
  dv.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(jsonBuf, 20);
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBuf.byteLength + i] = 0x20;

  let off = 20 + jsonChunkLen;
  dv.setUint32(off, binChunkLen, true);
  dv.setUint32(off + 4, 0x004e4942, true); // BIN
  off += 8;
  out.set(posBytes, off);
  off += posBytes.byteLength;
  out.set(normBytes, off);
  off += normBytes.byteLength;
  out.set(idxBytes, off);
  // pad bytes default to 0

  return out;
}

describe('parseGLBToMeshData / loadGLBToMeshData — material colour round-trip', () => {
  // Regression for #688: GLB importer hardcoded grey, silently dropping the
  // exporter's per-mesh material colours on re-import.
  it('reads pbrMetallicRoughness.baseColorFactor into MeshData.color', () => {
    const colors: Array<[number, number, number, number]> = [
      [0.8, 0.2, 0.2, 1.0],
      [0.1, 0.6, 0.3, 0.5],
      [0.0, 0.0, 1.0, 1.0],
    ];
    const meshes = loadGLBToMeshData(buildGLB(colors));
    expect(meshes).toHaveLength(3);
    for (let i = 0; i < colors.length; i++) {
      const expected = colors[i];
      const actual = meshes[i].color;
      expect(actual[0]).toBeCloseTo(expected[0]);
      expect(actual[1]).toBeCloseTo(expected[1]);
      expect(actual[2]).toBeCloseTo(expected[2]);
      expect(actual[3]).toBeCloseTo(expected[3]);
    }
  });

  it('falls back to default grey when a primitive has no material', () => {
    const glb = buildGLB([[0.5, 0.5, 0.5, 1.0]]);
    // Hand-strip material from the primitive to simulate a 3rd-party GLB.
    const txt = new TextDecoder().decode(glb.subarray(20, 20 + new DataView(glb.buffer).getUint32(12, true)));
    expect(txt).toContain('"material":0');

    // Drop just `materials` from the GLB and re-pack. Easier: parse-with-no-
    // materials by emulating an external file via a fresh buildGLB whose
    // resolver receives an undefined material index.
    const meshes = parseGLBToMeshData(
      {
        asset: { version: '2.0' },
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [
          {
            primitives: [
              {
                attributes: { POSITION: 0, NORMAL: 1 },
                indices: 2,
              },
            ],
          },
        ],
        accessors: [
          { bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3' },
          { bufferView: 1, byteOffset: 0, componentType: 5126, count: 3, type: 'VEC3' },
          { bufferView: 2, byteOffset: 0, componentType: 5125, count: 3, type: 'SCALAR' },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 36, byteStride: 12, target: 34962 },
          { buffer: 0, byteOffset: 36, byteLength: 36, byteStride: 12, target: 34962 },
          { buffer: 0, byteOffset: 72, byteLength: 12, target: 34963 },
        ],
        buffers: [{ byteLength: 84 }],
      },
      new Uint8Array(84),
    );
    expect(meshes).toHaveLength(1);
    expect(meshes[0].color).toEqual([0.8, 0.8, 0.8, 1.0]);
  });
});
