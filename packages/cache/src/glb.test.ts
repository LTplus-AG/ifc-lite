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

describe('parseGLB — SharedArrayBuffer-backed input', () => {
  // The viewer streams large imports (>= 256 MB) into a SharedArrayBuffer
  // (acquireFileBuffer). In a browser, `TextDecoder.decode` rejects any
  // SAB-backed view (a Spectre mitigation) with "...can't be a SharedArrayBuffer
  // ...", which crashed re-import of large exported GLBs. The JSON chunk now goes
  // through safeUtf8Decode, which copies it into a private buffer on the SAB path.
  //
  // NOTE: Node's TextDecoder does NOT reproduce the browser's SAB rejection, so
  // this is a path-coverage / documentation test (it exercises the SAB input and
  // asserts correctness), not a guard that can fail on the pre-fix code in CI.
  it('parses a GLB whose bytes are backed by a SharedArrayBuffer', () => {
    const glb = buildGLB([[0.2, 0.4, 0.6, 1.0]]);
    const sab = new SharedArrayBuffer(glb.byteLength);
    const shared = new Uint8Array(sab);
    shared.set(glb);
    const meshes = loadGLBToMeshData(shared);
    expect(meshes).toHaveLength(1);
    expect(meshes[0].color[0]).toBeCloseTo(0.2);
    expect(meshes[0].color[2]).toBeCloseTo(0.6);
  });
});

describe('parseGLBToMeshData — node translation → origin', () => {
  // The exporter parents every element node under ONE translated root node (the
  // placement rides that root; vertices are scene-centre-relative). A parser that
  // ignored node transforms would land the whole model at the centre. We surface
  // the composed root translation as `MeshData.origin` (world = origin + position)
  // rather than baking it into the f32 vertices — see the georef-precision test.
  it('surfaces a composed root translation as origin, leaving vertices local', () => {
    const bin = new Uint8Array(84);
    const fv = new Float32Array(bin.buffer);
    fv.set([0, 0, 0, 1, 0, 0, 0, 1, 0], 0); // positions (centre-relative)
    fv.set([0, 0, 1, 0, 0, 1, 0, 0, 1], 9); // normals
    new Uint32Array(bin.buffer, 72, 3).set([0, 1, 2]); // indices

    const meshes = parseGLBToMeshData(
      {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        // node 0 = translated root parenting node 1; node 1 = the mesh.
        nodes: [
          { children: [1], translation: [10, 20, 30] },
          { mesh: 0, extras: { expressId: 42 } },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
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
      bin,
    );

    expect(meshes).toHaveLength(1);
    expect(meshes[0].expressId).toBe(42);
    // Placement rides `origin`; vertices stay local (world = origin + position).
    expect(meshes[0].origin).toEqual([10, 20, 30]);
    expect(Array.from(meshes[0].positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('uses a mesh node’s own translation as origin when unreachable from the scene root', () => {
    // node 0 is the scene root (no mesh); the mesh lives on node 1 which is NOT a
    // child of node 0 (disconnected). Extraction must still apply node 1's own
    // translation rather than emit it as the scene root's.
    const bin = new Uint8Array(84);
    const fv = new Float32Array(bin.buffer);
    fv.set([0, 0, 0, 1, 0, 0, 0, 1, 0], 0);
    fv.set([0, 0, 1, 0, 0, 1, 0, 0, 1], 9);
    new Uint32Array(bin.buffer, 72, 3).set([0, 1, 2]);

    const meshes = parseGLBToMeshData(
      {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0] }], // only node 0 is in the scene; node 1 is orphaned
        nodes: [
          { translation: [100, 0, 0] }, // root, no mesh, not a parent of node 1
          { mesh: 0, translation: [5, 6, 7], extras: { expressId: 7 } },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
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
      bin,
    );

    expect(meshes).toHaveLength(1);
    // node 1's own translation [5,6,7] is applied (NOT node 0's [100,0,0]).
    expect(meshes[0].origin).toEqual([5, 6, 7]);
    expect(Array.from(meshes[0].positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('keeps sub-metre detail for a georeferenced root translation (no f32 collapse)', () => {
    // Regression for the GLB-roundtrip corruption: a georef root translation
    // (~6e6 m) baked into f32 vertices re-snaps everything to a ~0.5 m grid. With
    // the translation on `origin`, the centre-relative vertices keep full f32
    // precision and the cm-scale spread survives the round-trip.
    const bin = new Uint8Array(84);
    const fv = new Float32Array(bin.buffer);
    // Three vertices 0.04 m apart in X, 0.31 m offset in Z — the kind of detail a
    // rebar cross-section carries.
    fv.set([-0.02, 0, 0.31, 0.02, 0, 0.31, 0, 5, 0.31], 0);
    fv.set([0, 0, 1, 0, 0, 1, 0, 0, 1], 9);
    new Uint32Array(bin.buffer, 72, 3).set([0, 1, 2]);

    const sceneCenter = [501018.54, 53, -6083869.35]; // EPSG:4326-scale, Y-up GLB frame
    const meshes = parseGLBToMeshData(
      {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [1] }],
        nodes: [
          { mesh: 0, extras: { expressId: 7 } },
          { children: [0], translation: sceneCenter },
        ],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2 }] }],
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
      bin,
    );

    expect(meshes).toHaveLength(1);
    expect(meshes[0].origin).toEqual(sceneCenter);
    const p = meshes[0].positions;
    // Full precision retained: 0.04 m X-spread and 0.31 m Z-offset survive exactly.
    expect(p[3] - p[0]).toBeCloseTo(0.04, 6);
    expect(p[2]).toBeCloseTo(0.31, 6);
  });
});
