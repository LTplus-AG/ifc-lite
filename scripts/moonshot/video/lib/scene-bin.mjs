/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Binary scene serializer for the moonshot video pipelines.
 *
 * Converts the wasm GeometryProcessor's MeshData list into a compact
 * per-building binary "scene" file the viewer page loads with one fetch:
 *
 *   uint32 magic 0x53434e31 ("SCN1" LE)
 *   uint32 headerLen (bytes, padded to a multiple of 4)
 *   headerLen bytes of JSON: { groups: [{ color, vtx, idx }], bounds }
 *   then, per group in order: positions f32*3*vtx, normals f32*3*vtx,
 *   indices u32*idx.
 *
 * Meshes are merged into one group per RGBA color (the whole point: a
 * building renders as a handful of draw calls no matter how many elements
 * it has). Per-mesh `origin` local frames are folded into the positions,
 * so group positions are absolute scene coordinates (WebGL Y-up, metres).
 *
 * Non-rendered geometry (IfcOpeningElement proxies, IfcSpace volumes,
 * geometryClass 2 instancing templates) is dropped here, once.
 */

export const SCENE_MAGIC = 0x53434e31;

const SKIP_TYPES = new Set(['IfcOpeningElement', 'IfcSpace']);

/**
 * @param {Array} meshes GeometryProcessor MeshData list
 * @param {(mesh: object) => [number, number, number, number] | null} colorFor
 *   returns the RGBA to render this mesh with (null = skip the mesh)
 * @param {{ offset?: [number, number, number] }} opts optional translation
 *   added to every vertex AFTER the per-mesh origin fold (used by the grid
 *   pipeline to re-base each building on its own footprint centre at y=0,
 *   so per-scene scaling in the viewer pivots around the building base)
 * @returns {{ buffer: Buffer, header: object }}
 */
export function serializeScene(meshes, colorFor, opts = {}) {
  const off = opts.offset ?? [0, 0, 0];
  const groups = new Map(); // colorKey -> { color, meshes: [] }
  const bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };

  for (const mesh of meshes) {
    if ((mesh.geometryClass ?? 0) === 2) continue;
    if (SKIP_TYPES.has(mesh.ifcType)) continue;
    if (!mesh.indices || mesh.indices.length === 0) continue;
    const color = colorFor(mesh);
    if (!color) continue;
    const key = color.map((c) => c.toFixed(4)).join(',');
    let g = groups.get(key);
    if (!g) {
      g = { color, meshes: [], vtx: 0, idx: 0 };
      groups.set(key, g);
    }
    g.meshes.push(mesh);
    g.vtx += mesh.positions.length / 3;
    g.idx += mesh.indices.length;
  }

  const groupList = [...groups.values()];
  // Deterministic group order: opaque first (render-order friendly), then
  // by color key.
  groupList.sort((a, b) => {
    const ta = a.color[3] < 0.999 ? 1 : 0;
    const tb = b.color[3] < 0.999 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    return a.color.join(',') < b.color.join(',') ? -1 : 1;
  });

  let blobBytes = 0;
  for (const g of groupList) blobBytes += g.vtx * 24 + g.idx * 4;

  const headerObj = { groups: [], bounds };
  const parts = [];
  for (const g of groupList) {
    const positions = new Float32Array(g.vtx * 3);
    const normals = new Float32Array(g.vtx * 3);
    const indices = new Uint32Array(g.idx);
    let vo = 0;
    let io = 0;
    for (const mesh of g.meshes) {
      const o = mesh.origin ?? [0, 0, 0];
      const p = mesh.positions;
      const n = mesh.normals;
      const base = vo / 3;
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i] + o[0] + off[0];
        const y = p[i + 1] + o[1] + off[1];
        const z = p[i + 2] + o[2] + off[2];
        positions[vo + i] = x;
        positions[vo + i + 1] = y;
        positions[vo + i + 2] = z;
        normals[vo + i] = n[i];
        normals[vo + i + 1] = n[i + 1];
        normals[vo + i + 2] = n[i + 2];
        if (x < bounds.min[0]) bounds.min[0] = x;
        if (y < bounds.min[1]) bounds.min[1] = y;
        if (z < bounds.min[2]) bounds.min[2] = z;
        if (x > bounds.max[0]) bounds.max[0] = x;
        if (y > bounds.max[1]) bounds.max[1] = y;
        if (z > bounds.max[2]) bounds.max[2] = z;
      }
      // IFC mesh winding is unreliable (meshes are double-sided by design;
      // see packages/geometry MeshData docs). Re-orient each triangle so its
      // geometric normal agrees with the authored vertex normals, so a
      // front-face-lit material shades correctly from the outside.
      for (let i = 0; i < mesh.indices.length; i += 3) {
        let ia = mesh.indices[i];
        let ib = mesh.indices[i + 1];
        let ic = mesh.indices[i + 2];
        const ax = p[ia * 3], ay = p[ia * 3 + 1], az = p[ia * 3 + 2];
        const bx = p[ib * 3], by = p[ib * 3 + 1], bz = p[ib * 3 + 2];
        const cx = p[ic * 3], cy = p[ic * 3 + 1], cz = p[ic * 3 + 2];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const wx = cx - ax, wy = cy - ay, wz = cz - az;
        const gx = uy * wz - uz * wy;
        const gy = uz * wx - ux * wz;
        const gz = ux * wy - uy * wx;
        const nx = n[ia * 3] + n[ib * 3] + n[ic * 3];
        const ny = n[ia * 3 + 1] + n[ib * 3 + 1] + n[ic * 3 + 1];
        const nz = n[ia * 3 + 2] + n[ib * 3 + 2] + n[ic * 3 + 2];
        if (gx * nx + gy * ny + gz * nz < 0) {
          const tmp = ib; ib = ic; ic = tmp;
        }
        indices[io + i] = ia + base;
        indices[io + i + 1] = ib + base;
        indices[io + i + 2] = ic + base;
      }
      vo += p.length;
      io += mesh.indices.length;
    }
    headerObj.groups.push({ color: g.color, vtx: g.vtx, idx: g.idx });
    parts.push(Buffer.from(positions.buffer), Buffer.from(normals.buffer), Buffer.from(indices.buffer));
  }

  const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const headerLen = Math.ceil(headerJson.length / 4) * 4;
  const head = Buffer.alloc(8 + headerLen);
  head.writeUInt32LE(SCENE_MAGIC, 0);
  head.writeUInt32LE(headerLen, 4);
  headerJson.copy(head, 8);
  const buffer = Buffer.concat([head, ...parts]);
  if (buffer.length !== 8 + headerLen + blobBytes) {
    throw new Error(`scene-bin size mismatch: ${buffer.length} vs ${8 + headerLen + blobBytes}`);
  }
  return { buffer, header: headerObj };
}

/** Union of two {min,max} bounds objects (either may be null). */
export function unionBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    min: a.min.map((v, i) => Math.min(v, b.min[i])),
    max: a.max.map((v, i) => Math.max(v, b.max[i])),
  };
}
