/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8564 demo inputs, served by the spike's narrow /fixtures middleware
// (vite.config.mjs; prepare.mjs pins sizes and SHA-256). IFC meshes come from the
// published @ifc-lite/wasm runtime exactly as the spike decodes them; captures
// are parsed by SplatTransform, never by code in this repository.
import { MemoryReadFileSystem, readFile, materializeToDataTable, createChunkDataPool } from '@playcanvas/splat-transform';

async function fetchBytes(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} (run examples/gaussian-splat-spike/prepare.mjs)`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Viewer MeshData (Y-up metres, per-element origin) for every occurrence of the fixture IFC. */
export async function loadIfcMeshes(onProgress = () => {}) {
  const wasm = await import(/* @vite-ignore */ new URL('/fixtures/wasm/ifc-lite.js', location.href).href);
  await wasm.default();
  const bytes = await fetchBytes('/fixtures/model.ifc');
  const meshes = [];
  const api = new wasm.IfcAPI();
  try {
    const pre = api.buildPrePassOnce(bytes);
    for (let start = 0; start < pre.totalJobs; start += 50) {
      const collection = api.processGeometryBatch(bytes, pre.jobs.slice(start * 3, (start + 50) * 3), pre.unitScale,
        ...pre.rtcOffset, pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
        pre.planeAngleToRadians, pre.materialElementIds, pre.materialColorCounts, pre.materialColors);
      try {
        for (let i = 0; i < collection.length; i++) {
          const mesh = collection.get(i);
          if (!mesh) continue;
          try {
            const geometryClass = mesh.geometryClass ?? 0;
            if (geometryClass === 2) continue; // instanced type template: never drawn in the model view
            const color = mesh.color, origin = mesh.origin;
            meshes.push({ expressId: mesh.expressId, ifcType: mesh.ifcType, positions: mesh.positions, normals: mesh.normals,
              indices: mesh.indices, color: [color[0], color[1], color[2], color[3]], geometryClass,
              ...(origin && (origin[0] || origin[1] || origin[2]) ? { origin: [origin[0], origin[1], origin[2]] } : {}) });
          } finally { mesh.free(); }
        }
      } finally { collection.free(); }
      onProgress(Math.min(pre.totalJobs, start + 50), pre.totalJobs);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { meshes, rtcOffset: pre.needsShift ? Array.from(pre.rtcOffset) : [0, 0, 0] };
  } finally { api.clearPrePassCache(); api.free(); }
}

/**
 * SplatTransform's PLY-space columns (log scale, logit opacity, DC colour, higher
 * SH) for one served capture, parsed by its own `.splat` or `.ply` reader.
 */
export async function loadCaptureColumns(url, inputFormat) {
  const filename = `capture.${inputFormat}`;
  const fs = new MemoryReadFileSystem();
  fs.set(filename, await fetchBytes(url));
  const sources = await readFile({ filename, inputFormat, fileSystem: fs });
  const pool = createChunkDataPool({ maxPooledBytes: 32 * 1024 * 1024 });
  try {
    const table = await materializeToDataTable(sources[0], pool);
    const columns = Object.fromEntries(table.columns.map(column => [column.name, column.data instanceof Float32Array ? column.data : Float32Array.from(column.data)]));
    const rest = Object.keys(columns).filter(name => name.startsWith('f_rest_')).length;
    const shDegree = { 0: 0, 9: 1, 24: 2, 45: 3 }[rest];
    if (shDegree === undefined) throw new Error(`${url}: unexpected ${rest} higher-order SH columns`);
    return { count: table.numRows, shDegree, columns };
  } finally {
    for (const source of sources) source.close();
    pool.destroy();
  }
}
