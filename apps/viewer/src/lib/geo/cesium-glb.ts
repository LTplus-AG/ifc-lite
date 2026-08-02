/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';

/**
 * Build a minimal GLB with all geometry merged into a SINGLE mesh, for the
 * Cesium 3D-map overlay. MUCH faster than the per-node GLTFExporter (42K-mesh
 * model: GLTFExporter takes seconds, this ~100ms). It consumes the SAME canonical
 * `MeshData` the WebGPU viewer renders (void cuts / rect-fast / local-frame
 * already baked in by the Rust geometry engine) — no separate extraction.
 *
 * Packs POSITION + NORMAL + COLOR_0 and a lit double-sided PBR material so
 * Cesium shades the model with its sun: recessed faces (window/door reveals)
 * read as 3D instead of flat strips that look like wrong cuts (#1355 follow-up).
 */
export function buildMergedGLB(meshes: MeshData[]): Uint8Array {
  // Pass 1: calculate total sizes
  let totalVerts = 0;
  let totalIdxs = 0;
  for (const m of meshes) {
    if (!m.positions?.length || !m.indices?.length) continue;
    totalVerts += m.positions.length / 3;
    totalIdxs += m.indices.length;
  }

  // Allocate merged buffers
  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const colors = new Uint8Array(totalVerts * 4);
  const indices = new Uint32Array(totalIdxs);

  // Pass 2: merge
  let vertOff = 0;
  let idxOff = 0;
  for (const m of meshes) {
    if (!m.positions?.length || !m.indices?.length) continue;
    const nv = m.positions.length / 3;
    // Positions are in the element's local frame (world = origin + position);
    // fold the per-mesh origin while merging so the GLB is world-space. No-op
    // when origin is absent/[0,0,0].
    const ox = m.origin?.[0] ?? 0, oy = m.origin?.[1] ?? 0, oz = m.origin?.[2] ?? 0;
    if (ox !== 0 || oy !== 0 || oz !== 0) {
      for (let i = 0; i < nv; i++) {
        const s = (vertOff + i) * 3, t = i * 3;
        positions[s] = m.positions[t] + ox;
        positions[s + 1] = m.positions[t + 1] + oy;
        positions[s + 2] = m.positions[t + 2] + oz;
      }
    } else {
      positions.set(m.positions, vertOff * 3);
    }
    // Normals (directions — not origin-shifted) so Cesium can light the model
    // and recessed faces (window/door reveals) read as 3D instead of flat
    // strips. Fall back to +Z for any mesh missing per-vertex normals.
    if (m.normals?.length === nv * 3) {
      normals.set(m.normals, vertOff * 3);
    } else {
      for (let i = 0; i < nv; i++) {
        const s = (vertOff + i) * 3;
        normals[s] = 0; normals[s + 1] = 0; normals[s + 2] = 1;
      }
    }
    // Vertex colors from mesh color
    const r = Math.round((m.color?.[0] ?? 0.7) * 255);
    const g = Math.round((m.color?.[1] ?? 0.7) * 255);
    const b = Math.round((m.color?.[2] ?? 0.7) * 255);
    const a = Math.round((m.color?.[3] ?? 1.0) * 255);
    for (let i = 0; i < nv; i++) {
      const ci = (vertOff + i) * 4;
      colors[ci] = r; colors[ci + 1] = g; colors[ci + 2] = b; colors[ci + 3] = a;
    }
    for (let i = 0; i < m.indices.length; i++) {
      indices[idxOff + i] = m.indices[i] + vertOff;
    }
    vertOff += nv;
    idxOff += m.indices.length;
  }

  // Compute bounds
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (totalVerts === 0) { minX = minY = minZ = 0; maxX = maxY = maxZ = 0; }

  // Build minimal glTF JSON. BIN layout: positions, normals, colors, indices.
  const posByteLen = positions.byteLength;
  const nrmByteLen = normals.byteLength;
  const colByteLen = colors.byteLength;
  const idxByteLen = indices.byteLength;
  const totalBinLen = posByteLen + nrmByteLen + colByteLen + idxByteLen;

  const gltf = {
    asset: { version: '2.0', generator: 'IFC-Lite-Cesium' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    // Lit PBR material (NOT unlit): Cesium shades it with its sun via the
    // per-vertex normals so recessed reveals/cuts read in 3D. Vertex colours
    // (COLOR_0) multiply the white baseColorFactor, so element colours show.
    // Double-sided because IFC winding isn't reliably outward (see AGENTS.md).
    materials: [{
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 },
      doubleSided: true,
    }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: totalVerts, type: 'VEC3', min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
      { bufferView: 1, componentType: 5126, count: totalVerts, type: 'VEC3' },
      { bufferView: 2, componentType: 5121, count: totalVerts, type: 'VEC4', normalized: true },
      { bufferView: 3, componentType: 5125, count: totalIdxs, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posByteLen, target: 34962 },
      { buffer: 0, byteOffset: posByteLen, byteLength: nrmByteLen, target: 34962 },
      { buffer: 0, byteOffset: posByteLen + nrmByteLen, byteLength: colByteLen, target: 34962 },
      { buffer: 0, byteOffset: posByteLen + nrmByteLen + colByteLen, byteLength: idxByteLen, target: 34963 },
    ],
    buffers: [{ byteLength: totalBinLen }],
  };

  const jsonStr = JSON.stringify(gltf);
  const jsonBuf = new TextEncoder().encode(jsonStr);
  // Pad JSON to 4-byte alignment
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const jsonChunkLen = jsonBuf.length + jsonPad;
  // Pad binary to 4-byte alignment
  const binPad = (4 - (totalBinLen % 4)) % 4;
  const binChunkLen = totalBinLen + binPad;

  // GLB: 12-byte header + 8-byte JSON chunk header + JSON + 8-byte BIN chunk header + BIN
  const glbLen = 12 + 8 + jsonChunkLen + 8 + binChunkLen;
  const glb = new ArrayBuffer(glbLen);
  const view = new DataView(glb);
  let off = 0;

  // GLB header
  view.setUint32(off, 0x46546C67, true); off += 4; // magic "glTF"
  view.setUint32(off, 2, true); off += 4;           // version
  view.setUint32(off, glbLen, true); off += 4;       // total length

  // JSON chunk
  view.setUint32(off, jsonChunkLen, true); off += 4;
  view.setUint32(off, 0x4E4F534A, true); off += 4;   // "JSON"
  new Uint8Array(glb, off, jsonBuf.length).set(jsonBuf); off += jsonBuf.length;
  for (let i = 0; i < jsonPad; i++) view.setUint8(off++, 0x20); // space padding

  // BIN chunk
  view.setUint32(off, binChunkLen, true); off += 4;
  view.setUint32(off, 0x004E4942, true); off += 4;   // "BIN\0"
  new Uint8Array(glb, off, posByteLen).set(new Uint8Array(positions.buffer)); off += posByteLen;
  new Uint8Array(glb, off, nrmByteLen).set(new Uint8Array(normals.buffer)); off += nrmByteLen;
  new Uint8Array(glb, off, colByteLen).set(colors); off += colByteLen;
  new Uint8Array(glb, off, idxByteLen).set(new Uint8Array(indices.buffer)); off += idxByteLen;

  return new Uint8Array(glb);
}
