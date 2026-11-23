/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * HLOD proxy simplifier for the draw stream, run in a dedicated worker
 * started from an inline Blob (no bundler worker plumbing). Plain JS source.
 *
 * Input: one node's triangle soup, positions relative to the node origin, a
 * per-vertex element id and colour slot. Per colour slot, vertices are
 * clustered on a uniform grid of `cell` metres (vertex clustering, the same
 * family as LOD1's sloppy decimation); triangles collapsing inside one cell
 * and duplicates are dropped; survivors are emitted flat-shaded (three
 * vertices per triangle, face normal) carrying the cluster's first element id.
 * Small elements vanish once they fit inside one cell, which is what makes a
 * far-field proxy cheap: furniture, fittings and pipes collapse, envelopes stay.
 */
export const PROXY_WORKER_SOURCE = `
self.onmessage = (event) => {
  const { job, positions, ids, colors, indices, cell } = event.data;
  const inv = 1 / cell;
  const cluster = new Map();
  const sx = [], sy = [], sz = [], sn = [], sid = [];
  const bySlot = new Map();
  const seen = new Map();
  const k = [0, 0, 0];
  for (let t = 0; t < indices.length; t += 3) {
    const slot = colors[indices[t]];
    for (let j = 0; j < 3; j++) {
      const v = indices[t + j];
      const x = positions[3 * v], y = positions[3 * v + 1], z = positions[3 * v + 2];
      const key = (((Math.floor(x * inv) + 1024) * 2048 + (Math.floor(y * inv) + 1024)) * 2048 + (Math.floor(z * inv) + 1024)) * 1024 + slot;
      let ci = cluster.get(key);
      if (ci === undefined) { ci = sx.length; cluster.set(key, ci); sx.push(0); sy.push(0); sz.push(0); sn.push(0); sid.push(ids[v]); }
      sx[ci] += x; sy[ci] += y; sz[ci] += z; sn[ci]++;
      k[j] = ci;
    }
    if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) continue;
    const a = Math.min(k[0], k[1], k[2]), c = Math.max(k[0], k[1], k[2]), b = k[0] + k[1] + k[2] - a - c;
    const ab = a * 4194304 + b;
    let cs = seen.get(ab);
    if (!cs) { cs = new Set(); seen.set(ab, cs); }
    if (cs.has(c)) continue;
    cs.add(c);
    let list = bySlot.get(slot);
    if (!list) { list = []; bySlot.set(slot, list); }
    list.push(k[0], k[1], k[2]);
  }
  const out = [];
  const transfer = [];
  for (const [slot, tri] of bySlot) {
    const n = tri.length;
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), eid = new Uint32Array(n);
    const vtx = new Float32Array(n * 7), vtxU = new Uint32Array(vtx.buffer);
    const p = new Float64Array(9);
    for (let i = 0; i < n; i += 3) {
      for (let j = 0; j < 3; j++) { const ci = tri[i + j]; p[3 * j] = sx[ci] / sn[ci]; p[3 * j + 1] = sy[ci] / sn[ci]; p[3 * j + 2] = sz[ci] / sn[ci]; }
      const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      for (let j = 0; j < 3; j++) {
        const o = 3 * (i + j);
        pos[o] = p[3 * j]; pos[o + 1] = p[3 * j + 1]; pos[o + 2] = p[3 * j + 2];
        nrm[o] = nx; nrm[o + 1] = ny; nrm[o + 2] = nz;
        eid[i + j] = sid[tri[i + j]];
        const w = 7 * (i + j);
        vtx[w] = pos[o]; vtx[w + 1] = pos[o + 1]; vtx[w + 2] = pos[o + 2];
        vtx[w + 3] = nx; vtx[w + 4] = ny; vtx[w + 5] = nz; vtxU[w + 6] = eid[i + j];
      }
    }
    out.push({ slot, positions: pos, ids: eid, vertices: vtx });
    transfer.push(pos.buffer, eid.buffer, vtx.buffer);
  }
  self.postMessage({ job, pieces: out }, transfer);
};
`;
