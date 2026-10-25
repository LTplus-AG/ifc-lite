/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { MemoryReadFileSystem, readFile, materializeToDataTable, createChunkDataPool } from '@playcanvas/splat-transform';
import { GSplatData, Vec3, Quat, Color } from 'playcanvas';
export async function decodeCapture(id) {
  const response = await fetch(`/fixtures/${id}.splat`);
  if (!response.ok) throw new Error(`Capture HTTP ${response.status}`);
  return decodeCaptureBytes(new Uint8Array(await response.arrayBuffer()), id);
}
export async function decodeCaptureBytes(bytes, id = 'capture') {
  const fs = new MemoryReadFileSystem();
  fs.set(`${id}.splat`, bytes);
  const sources = await readFile({ filename: `${id}.splat`, inputFormat: 'splat', fileSystem: fs });
  const pool = createChunkDataPool({ maxPooledBytes: 32 * 1024 * 1024 });
  try {
    const table = await materializeToDataTable(sources[0], pool);
    const data = new GSplatData([{ name: 'vertex', count: table.numRows,
      properties: table.columns.map(column => ({ name: column.name, type: 'float', byteSize: 4, storage: column.data })) }]);
    // Source captures declare -Y up. Their .splat decoder returns PLY space;
    // the fixture placement applies a 180-degree X rotation for Y-up display.
    return data;
  } finally { for (const source of sources) source.close(); pool.destroy(); }
}
export function captureColumns(data, offset, scale = 2) {
  const n = data.numSplats;
  const positions = new Float32Array(n * 3), scales = new Float32Array(n * 3);
  const rotations = new Float32Array(n * 4), colors = new Uint8Array(n * 4), opacities = new Float32Array(n);
  const p = new Vec3(), r = new Quat(), s = new Vec3(), c = new Color();
  const iter = data.createIter(p, r, s, c);
  for (let i = 0; i < n; i++) {
    iter.read(i);
    positions.set([p.x * scale + offset[0], -p.y * scale + offset[1], -p.z * scale + offset[2]], i * 3);
    scales.set([s.x * scale, s.y * scale, s.z * scale], i * 3);
    // Rotation X(pi) multiplied by source quaternion, packed WXYZ for luma.
    rotations.set([-r.x, r.w, -r.z, r.y], i * 4);
    colors.set([c.r, c.g, c.b].map(v => Math.round(Math.max(0, Math.min(1, v)) * 255)).concat(255), i * 4);
    opacities[i] = c.a;
  }
  return { positions, scales, rotations, colors, opacities };
}
export async function decodeIfc() {
  const wasmUrl = new URL('/fixtures/wasm/ifc-lite.js', location.href).href;
  const wasm = await import(/* @vite-ignore */ wasmUrl);
  await wasm.default();
  const api = new wasm.IfcAPI();
  const response = await fetch('/fixtures/model.ifc');
  if (!response.ok) throw new Error(`IFC HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const meshes = [];
  try {
    const pre = api.buildPrePassOnce(bytes);
    meshes.rtcOffset = pre.needsShift ? Array.from(pre.rtcOffset) : [0, 0, 0];
    for (let start = 0; start < pre.totalJobs; start += 50) {
      const collection = api.processGeometryBatch(bytes, pre.jobs.slice(start * 3, (start + 50) * 3), pre.unitScale,
        ...pre.rtcOffset, pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
        pre.planeAngleToRadians, pre.materialElementIds, pre.materialColorCounts, pre.materialColors);
      try {
        for (let i = 0; i < collection.length; i++) {
          const mesh = collection.get(i);
          if (!mesh) continue;
          try {
            const positions = mesh.positions, origin = mesh.origin;
            for (let j = 0; j < positions.length; j++) positions[j] += origin[j % 3];
            meshes.push({ positions, indices: mesh.indices, color: Array.from(mesh.color), expressId: mesh.expressId });
          } finally { mesh.free(); }
        }
      } finally { collection.free(); }
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  } finally { api.clearPrePassCache(); api.free(); }
  return meshes;
}
