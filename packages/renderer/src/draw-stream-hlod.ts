/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Hierarchical level of detail for the draw stream (`draw-stream.ts`).
 *
 * The draw stream's leaf nodes are the chunk cells (32 m). Above them sits an
 * octree of coarser nodes (64 m, 128 m, ...). Each coarse node owns a proxy:
 * all geometry inside it merged per colour and vertex-clustered on a grid of
 * `nodeSize / grid` metres (draw-stream-proxy-worker.ts). Level 1 proxies are
 * built from the scene's mesh pieces, higher levels from their children's
 * proxies, in a worker, progressively, nearest-to-ready first.
 *
 * Selection, per frame, top down: a visible node whose proxy is ready, whose
 * cluster size projects below `errorPx` and that holds nothing needing
 * per-element treatment (a batch on the legacy path: partly hidden, X-Ray,
 * transparent, colour-painted) draws its proxy; otherwise it refines to its
 * children, and level 1 refines to the leaf cells. So hide/isolate/override
 * never apply to a proxy: they force refinement to real geometry. Picking
 * runs its own pass over the real batches and is unaffected.
 */
import type { MeshData } from '@ifc-lite/geometry';
import { PROXY_WORKER_SOURCE } from './draw-stream-proxy-worker.js';
import { STREAM_DELTA_FLOATS, STREAM_RECORD_FLOATS } from './shaders/main-stream.wgsl.js';
import { packMeshMaterial } from './mesh-material.js';
import { MESH_UNIFORM_FLOATS, MESH_UNIFORM_OFFSET } from './mesh-rte-uniforms.js';
import type { RelativeToEyeFrame } from './relative-to-eye.js';

type Finish = MeshData['material'];
import { growAabb, type Vec3 } from './draw-stream-types.js';

export interface ProxyDraw { vertexBuffer: GPUBuffer; baseVertex: number; count: number; record: number }

const PROXY_CHUNK_BYTES = 64 * 1024 * 1024;

export interface HlodNode {
  level: number;
  key: string;
  coords: Vec3;
  min: Vec3;
  max: Vec3;
  /** World cluster size of this node's proxy (its geometric error). */
  error: number;
  children: HlodNode[];
  state: 'idle' | 'pending' | 'ready' | 'empty';
  draws: ProxyDraw[];
  /** CPU copy of the proxy, input to the parent's build. */
  cpu: { slot: number; positions: Float32Array; ids: Uint32Array }[];
  tris: number;
  /** Perspective bundles per opaque draw mode (index = discardFree * 2 + objectId). */
  bundle: (GPURenderBundle | null)[];
  /** Orthographic colour/depth bundle pair. */
  ortho: (GPURenderBundle | null)[];
  pieces?: MeshData[];
}

interface ProxyPiece { slot: number; positions: Float32Array; ids: Uint32Array; vertices: Float32Array }

export interface HlodStats { nodes: number; ready: number; pending: number; proxyTris: number; proxyBytes: number; buildMs: number }

export const nodeKey = (level: number, c: Vec3): string => `${level}:${c[0]},${c[1]},${c[2]}`;

export class HlodTree {
  readonly levels: Map<string, HlodNode>[] = [];
  roots: HlodNode[] = [];
  private worker: Worker | null = null;
  private jobs = new Map<number, HlodNode>();
  private nextJob = 1;
  private readonly palette = new Map<string, number>();
  /** Proxy colour slots: colour and surface finish, as the source pieces drew them. */
  private readonly colours: { colour: [number, number, number, number]; finish: Finish | undefined }[] = [];
  private records = new Float32Array(0);
  private recordCount = 0;
  private origins: Vec3[] = [];
  recordBuffer: GPUBuffer | null = null;
  deltaBuffer: GPUBuffer | null = null;
  /** Bumped when the record/delta buffers are reallocated (bind group + bundles go stale). */
  generation = 0;
  private lastCamera: Vec3 = [NaN, NaN, NaN];
  private deltaImage = new Float32Array(0);
  private recordNodes: HlodNode[] = [];
  /** Keys of nodes holding a record outside the eye envelope at the last camera: they must not draw their proxy. */
  readonly outsideNodes = new Set<string>();
  private iota: GPUBuffer | null = null;
  private chunk: GPUBuffer | null = null;
  private chunkUsed = 0;
  private chunks: GPUBuffer[] = [];
  private iotaCount = 0;
  readonly stats: HlodStats = { nodes: 0, ready: 0, pending: 0, proxyTris: 0, proxyBytes: 0, buildMs: 0 };
  private buildStart = 0;
  private readonly scratch = new Float32Array(MESH_UNIFORM_FLOATS);

  constructor(private readonly device: GPUDevice, readonly leafCell: number, readonly grid: number, private readonly onReady: () => void) {}

  /** Assign every mesh piece to a level-1 node and derive the coarser levels. */
  build(forEachPiece: (visit: (m: MeshData) => void) => void): void {
    this.buildStart = performance.now();
    const l1 = new Map<string, HlodNode>();
    const size1 = this.leafCell * 2;
    forEachPiece((m) => {
      const p = m.positions; if (p.length < 9) return;
      const [ox, oy, oz] = m.origin ?? [0, 0, 0]; // positions are relative to the piece's own frame
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i]! + ox, y = p[i + 1]! + oy, z = p[i + 2]! + oz;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const c: Vec3 = [Math.floor((x0 + x1) / 2 / size1), Math.floor((y0 + y1) / 2 / size1), Math.floor((z0 + z1) / 2 / size1)];
      const k = nodeKey(1, c);
      let n = l1.get(k);
      if (!n) { n = this.makeNode(1, c, size1); n.pieces = []; l1.set(k, n); }
      n.pieces!.push(m);
      growAabb(n, [x0, y0, z0], [x1, y1, z1]);
    });
    this.levels.length = 0; this.levels[1] = l1;
    let level = 1;
    while (this.levels[level]!.size > 4 && level < 10) {
      const up = new Map<string, HlodNode>(); const size = this.leafCell * 2 ** (level + 1);
      for (const child of this.levels[level]!.values()) {
        const c: Vec3 = [child.coords[0] >> 1, child.coords[1] >> 1, child.coords[2] >> 1];
        const k = nodeKey(level + 1, c);
        let n = up.get(k);
        if (!n) { n = this.makeNode(level + 1, c, size); up.set(k, n); }
        n.children.push(child); growAabb(n, child.min, child.max);
      }
      this.levels[++level] = up;
    }
    this.roots = [...this.levels[level]!.values()];
    this.stats.nodes = this.levels.reduce((a, l) => a + (l ? l.size : 0), 0);
    this.pump();
  }

  private makeNode(level: number, coords: Vec3, size: number): HlodNode {
    return { level, key: nodeKey(level, coords), coords, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
      error: size / this.grid, children: [], state: 'idle', draws: [], cpu: [], tris: 0, bundle: [null, null, null, null], ortho: [null, null] };
  }

  private slotOf(color: readonly number[], finish: Finish | undefined): number {
    const k = `${color[0]!.toFixed(3)},${color[1]!.toFixed(3)},${color[2]!.toFixed(3)},${color[3]!.toFixed(3)}|${finish?.metallic ?? ''},${finish?.roughness ?? ''}`;
    let s = this.palette.get(k);
    if (s === undefined) { s = this.colours.length; this.palette.set(k, s); this.colours.push({ colour: [color[0]!, color[1]!, color[2]!, color[3]!], finish }); }
    return s;
  }

  /** Keep up to two builds in flight; level 1 first, a parent once all its children settled. */
  private pump(): void {
    if (this.jobs.size >= 2) return;
    this.worker ??= this.startWorker();
    for (let level = 1; level < this.levels.length && this.jobs.size < 2; level++) {
      const nodes = this.levels[level]; if (!nodes) continue;
      for (const n of nodes.values()) {
        if (this.jobs.size >= 2) break;
        if (n.state !== 'idle') continue;
        if (level > 1 && n.children.some((c) => c.state === 'idle' || c.state === 'pending')) continue;
        this.submit(n);
      }
    }
    this.stats.pending = this.jobs.size;
  }

  private startWorker(): Worker {
    const url = URL.createObjectURL(new Blob([PROXY_WORKER_SOURCE], { type: 'text/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url); // the worker has its script; keep no blob alive per tree
    w.onmessage = (e: MessageEvent<{ job: number; pieces: ProxyPiece[] }>) => this.finish(e.data.job, e.data.pieces);
    w.onerror = (e) => console.warn('[draw-stream hlod] proxy worker failed', e.message);
    return w;
  }

  private submit(n: HlodNode): void {
    const origin = centre(n);
    // gather: level 1 from mesh pieces, higher levels from children's proxies
    let verts = 0, idx = 0;
    if (n.level === 1) for (const m of n.pieces!) { verts += m.positions.length / 3; idx += m.indices.length; }
    else for (const c of n.children) for (const p of c.cpu) { verts += p.ids.length; idx += p.ids.length; }
    if (verts === 0) { n.state = 'empty'; return; }
    const positions = new Float32Array(verts * 3), ids = new Uint32Array(verts), colors = new Uint16Array(verts), indices = new Uint32Array(idx);
    let v = 0, t = 0;
    const put = (src: Float32Array, srcOrigin: Vec3, id: (i: number) => number, slot: number, tri: Uint32Array | null): void => {
      const base = v; const nv = src.length / 3;
      for (let i = 0; i < nv; i++) {
        positions[3 * v] = src[3 * i]! + srcOrigin[0] - origin[0]; positions[3 * v + 1] = src[3 * i + 1]! + srcOrigin[1] - origin[1]; positions[3 * v + 2] = src[3 * i + 2]! + srcOrigin[2] - origin[2];
        ids[v] = id(i); colors[v] = slot; v++;
      }
      if (tri) for (let i = 0; i < tri.length; i++) indices[t++] = base + tri[i]!;
      else for (let i = 0; i < nv; i++) indices[t++] = base + i;
    };
    if (n.level === 1) for (const m of n.pieces!) put(m.positions, m.origin ?? [0, 0, 0], m.entityIds ? (i) => m.entityIds![i]! : () => m.expressId, this.slotOf(m.color, m.material), m.indices);
    else for (const c of n.children) { const o = centre(c); for (const p of c.cpu) put(p.positions, o, (i) => p.ids[i]!, p.slot, null); }
    n.pieces = undefined;
    const job = this.nextJob++;
    this.jobs.set(job, n); n.state = 'pending';
    this.worker!.postMessage({ job, positions, ids, colors, indices, cell: n.error }, [positions.buffer, ids.buffer, colors.buffer, indices.buffer]);
  }

  private finish(job: number, pieces: ProxyPiece[]): void {
    const n = this.jobs.get(job); this.jobs.delete(job);
    if (!n) return;
    const origin = centre(n);
    // one node's pieces go contiguously into one shared proxy chunk
    let total = 0; for (const p of pieces) total += p.ids.length * 28;
    if (!this.chunk || this.chunkUsed + total > this.chunk.size) {
      this.chunk = this.device.createBuffer({ label: 'draw-stream-proxy-arena', size: Math.max(PROXY_CHUNK_BYTES, total), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      this.chunks.push(this.chunk); this.chunkUsed = 0; this.stats.proxyBytes += this.chunk.size;
    }
    for (const p of pieces) {
      const count = p.ids.length;
      const vb = this.chunk; const at = this.chunkUsed; this.chunkUsed += count * 28;
      this.device.queue.writeBuffer(vb, at, p.vertices); // interleaved in the worker
      n.draws.push({ vertexBuffer: vb, baseVertex: at / 28, count, record: this.addRecord(this.colours[p.slot]!, origin, n) });
      n.cpu.push({ slot: p.slot, positions: p.positions, ids: p.ids });
      n.tris += count / 3; this.stats.proxyTris += count / 3;
      this.ensureIota(count);
    }
    n.state = n.draws.length ? 'ready' : 'empty';
    // children's CPU copies are no longer needed once the parent is built
    for (const c of n.children) c.cpu = [];
    this.stats.ready++;
    this.flushRecords();
    if (this.jobs.size === 0 && [...this.nodes()].every((x) => x.state === 'ready' || x.state === 'empty')) {
      this.stats.buildMs = performance.now() - this.buildStart;
    }
    this.pump();
    this.onReady();
  }

  private addRecord({ colour, finish }: { colour: [number, number, number, number]; finish: Finish | undefined }, origin: Vec3, node: HlodNode): number {
    const i = this.recordCount++;
    if (this.records.length < this.recordCount * STREAM_RECORD_FLOATS) {
      const next = new Float32Array(Math.max(64, this.recordCount * 2) * STREAM_RECORD_FLOATS); next.set(this.records); this.records = next;
    }
    const r = this.records; const u = new Uint32Array(r.buffer); const o = i * STREAM_RECORD_FLOATS;
    r[o] = colour[0]; r[o + 1] = colour[1]; r[o + 2] = colour[2]; r[o + 3] = colour[3];
    packMeshMaterial(this.scratch, colour[3], finish); const mr = MESH_UNIFORM_OFFSET.metallicRoughness;
    r[o + 4] = this.scratch[mr]!; r[o + 5] = this.scratch[mr + 1]!; r[o + 6] = this.scratch[mr + 2]!; r[o + 7] = this.scratch[mr + 3]!;
    r[o + 12] = origin[0]; r[o + 13] = origin[1]; r[o + 14] = origin[2];
    u[o + 17] = 0xFFFFFFFF;
    this.origins[i] = origin; this.recordNodes[i] = node;
    return i;
  }

  private flushRecords(): void {
    const need = Math.max(1, this.recordCount);
    if (!this.recordBuffer || this.recordBuffer.size < need * STREAM_RECORD_FLOATS * 4) {
      this.recordBuffer?.destroy(); this.deltaBuffer?.destroy();
      const cap = Math.max(4096, need * 2);
      this.recordBuffer = this.device.createBuffer({ label: 'draw-stream-proxy-records', size: cap * STREAM_RECORD_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.deltaBuffer = this.device.createBuffer({ label: 'draw-stream-proxy-deltas', size: cap * STREAM_DELTA_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.generation++;
    }
    this.device.queue.writeBuffer(this.recordBuffer, 0, this.records, 0, this.recordCount * STREAM_RECORD_FLOATS);
    this.lastCamera = [NaN, NaN, NaN];
  }

  private ensureIota(count: number): void {
    if (this.iota && this.iotaCount >= count) return;
    this.iota?.destroy();
    this.iotaCount = Math.max(count, this.iotaCount * 2, 1 << 20);
    this.iota = this.device.createBuffer({ label: 'draw-stream-proxy-iota', size: this.iotaCount * 4, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
    const a = new Uint32Array(this.iota.getMappedRange()); for (let i = 0; i < a.length; i++) a[i] = i; this.iota.unmap();
    this.generation++;
  }

  iotaBuffer(): GPUBuffer | null { return this.iota; }

  /** Every node of every level. */
  *nodes(): Generator<HlodNode> {
    for (const level of this.levels) if (level) yield* level.values();
  }

  prepareFrame(rte: RelativeToEyeFrame): void {
    if (!this.deltaBuffer || this.recordCount === 0) return;
    const cam = rte.getCameraWorld();
    if (cam[0] === this.lastCamera[0] && cam[1] === this.lastCamera[1] && cam[2] === this.lastCamera[2]) return;
    this.lastCamera = [cam[0], cam[1], cam[2]];
    const floats = this.recordCount * STREAM_DELTA_FLOATS;
    if (this.deltaImage.length < floats) this.deltaImage = new Float32Array(Math.max(floats, this.deltaImage.length * 2));
    const d = this.deltaImage;
    this.outsideNodes.clear();
    for (let i = 0; i < this.recordCount; i++) if (!rte.tryPackDrawableOrigin(this.origins[i]!, d, i * STREAM_DELTA_FLOATS)) this.outsideNodes.add(this.recordNodes[i]!.key);
    this.device.queue.writeBuffer(this.deltaBuffer, 0, d, 0, floats);
  }

  destroy(): void {
    this.worker?.terminate(); this.worker = null; this.jobs.clear();
    for (const c of this.chunks) c.destroy(); this.chunks = []; this.chunk = null;
    this.recordBuffer?.destroy(); this.deltaBuffer?.destroy(); this.iota?.destroy();
  }
}

export function centre(n: { min: Vec3; max: Vec3 }): Vec3 {
  return [(n.min[0] + n.max[0]) / 2, (n.min[1] + n.max[1]) / 2, (n.min[2] + n.max[2]) / 2];
}
