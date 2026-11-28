/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spike (draw-stream `hlodIds`): proxy size with and without per-element ids,
 * on real geometry, with no GPU. Runs the real `HlodTree` and proxy worker
 * source over `GeometryProcessor` meshes (device and Worker are stubs that
 * only count), and prints per level: triangles, flat GPU bytes (28 B/vertex),
 * indexed tile bytes (spec R8 form) and the share of triangles whose three
 * vertex ids differ (the legacy rule's mixed-id triangles).
 *
 *   node scripts/hlod-ids-meshes.mjs MODEL.ifc M.bin && pnpm exec tsx scripts/hlod-ids-size.ts M.bin [grid=24] [leafCell=32]
 */
import { readFileSync } from 'node:fs';
import type { MeshData } from '@ifc-lite/geometry';
import { HlodTree } from '../src/draw-stream-hlod.js';
import { PROXY_WORKER_SOURCE } from '../src/draw-stream-proxy-worker.js';

interface Piece { slot: number; positions: Float32Array; ids: Uint32Array; vertices: Float32Array }

async function measure(meshes: MeshData[], ids: boolean, grid: number, leafCell: number) {
  const host = globalThis as Record<string, unknown>;
  host.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 };
  const perLevel = new Map<number, { tris: number; mixed: number; clusters: number; nodes: number }>();
  const jobLevel = new Map<number, number>();
  let tree: HlodTree | null = null;
  let pending = 0; let settle: () => void = () => {};
  const done = new Promise<void>((r) => { settle = r; });
  host.Worker = class {
    onmessage: ((e: { data: unknown }) => void) | null = null; onerror: unknown = null;
    private readonly impl: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: { job: number; pieces: Piece[] }) => void };
    constructor() {
      const self = this;
      this.impl = { onmessage: null, postMessage: (m) => {
        const level = jobLevel.get(m.job) ?? 0;
        const row = perLevel.get(level) ?? { tris: 0, mixed: 0, clusters: 0, nodes: 0 }; row.nodes++;
        for (const p of m.pieces) {
          const n = p.ids.length / 3; row.tris += n;
          const seen = new Set<string>();
          for (let t = 0; t < n; t++) {
            if (p.ids[3 * t] !== p.ids[3 * t + 1] || p.ids[3 * t + 1] !== p.ids[3 * t + 2]) row.mixed++;
            for (let j = 0; j < 3; j++) { const o = 3 * (3 * t + j); seen.add(`${p.positions[o]},${p.positions[o + 1]},${p.positions[o + 2]}`); }
          }
          row.clusters += seen.size;
        }
        perLevel.set(level, row);
        setImmediate(() => { self.onmessage?.({ data: m }); pending--; if (pending === 0) setImmediate(() => { if (pending === 0) settle(); }); });
      } };
      new Function('self', PROXY_WORKER_SOURCE)(this.impl);
    }
    postMessage(m: { job: number }) {
      pending++;
      jobLevel.set(m.job, (tree as unknown as { jobs: Map<number, { level: number }> }).jobs.get(m.job)!.level);
      this.impl.onmessage!({ data: m });
    }
    terminate() {}
  };
  host.URL = Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
  host.Blob ??= class {};
  const device = {
    createBuffer: (d: GPUBufferDescriptor) => ({ size: d.size, label: d.label, destroy() {}, getMappedRange: () => new ArrayBuffer(Math.min(d.size, 1 << 20)), unmap() {} }),
    queue: { writeBuffer: () => {} },
  } as unknown as GPUDevice;
  tree = new HlodTree(device, leafCell, grid, () => {}, ids);
  tree.build((visit) => { for (const m of meshes) visit(m); });
  if (pending > 0) await done;
  const levels = [...perLevel.entries()].sort((a, b) => a[0] - b[0]);
  tree.destroy();
  return levels.map(([level, r]) => ({ level, nodes: r.nodes, tris: r.tris, gpuBytes: r.tris * 3 * 28,
    // R8 indexed tile: f32x3 per cluster + u32 per cluster id (legacy) or u32 per triangle id (per-element) + u32x3 per triangle
    tileBytes: r.clusters * 12 + r.tris * 12 + (ids ? r.tris * 4 : r.clusters * 4), mixedShare: r.tris ? r.mixed / r.tris : 0 }));
}

const [file, gridArg, cellArg] = process.argv.slice(2);
if (!file) { console.error('usage: tsx scripts/hlod-ids-size.ts MODEL.ifc [grid] [leafCell]'); process.exit(2); }
// meshes come from hlod-ids-meshes.mjs (plain node; tsx cannot load the wasm package here)
const buf = readFileSync(file); const hl = buf.readUInt32LE(0);
const head = JSON.parse(buf.subarray(4, 4 + hl).toString()) as { expressId: number; color: number[]; material: unknown; origin: number[] | null; nPos: number; nIdx: number; ids: boolean }[];
let at = 4 + hl;
const take = <T>(n: number, C: new (b: ArrayBuffer) => T): T => { const c = new C(buf.buffer.slice(buf.byteOffset + at, buf.byteOffset + at + n * 4)); at += n * 4; return c; };
const meshes = head.map((h) => { const positions = take(h.nPos, Float32Array); const indices = take(h.nIdx, Uint32Array);
  const entityIds = h.ids ? take(h.nPos / 3, Uint32Array) : undefined;
  return { expressId: h.expressId, color: h.color, material: h.material ?? undefined, origin: h.origin ?? undefined, positions, indices, entityIds, normals: new Float32Array(0) } as unknown as MeshData; });
const flat = meshes;
let srcTris = 0; for (const m of flat) srcTris += m.indices.length / 3;
const grid = Number(gridArg ?? 24), leafCell = Number(cellArg ?? 32);
const legacy = await measure(flat, false, grid, leafCell);
const perElement = await measure(flat, true, grid, leafCell);
const sum = (rows: typeof legacy, k: 'tris' | 'gpuBytes' | 'tileBytes') => rows.reduce((a, r) => a + r[k], 0);
console.log(JSON.stringify({ file: file.split('/').pop(), meshes: flat.length, sourceTris: srcTris, grid, leafCell, legacy, perElement,
  total: { legacyTris: sum(legacy, 'tris'), idsTris: sum(perElement, 'tris'), trisGrowth: sum(perElement, 'tris') / Math.max(1, sum(legacy, 'tris')) - 1,
    legacyTileBytes: sum(legacy, 'tileBytes'), idsTileBytes: sum(perElement, 'tileBytes'), tileGrowth: sum(perElement, 'tileBytes') / Math.max(1, sum(legacy, 'tileBytes')) - 1 } }, null, 1));
process.exit(0);
