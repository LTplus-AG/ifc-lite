/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Stateless draw stream for flat colour batches.
 *
 * Legacy path, per visible batch and frame: frustum/contribution test,
 * 512 B uniform pack + upload, setPipeline?, setBindGroup, setVertexBuffer,
 * setIndexBuffer, drawIndexed — about 17k of each for a 700k-element campus.
 *
 * Stream path:
 *  - one pipeline per vertex layout and ONE bind group per frame: per-batch
 *    data lives in a static storage record indexed by `firstInstance`; the
 *    camera-relative origin deltas are refreshed in one write when the camera
 *    moves (f64 split on the CPU, bit-identical to the legacy packing);
 *  - batches are grouped into spatial nodes (one per chunk cell); the CPU
 *    culls nodes, not batches, and replays each node's pre-recorded render
 *    bundle (LOD0 or LOD1 by node size). A node's bundle is recorded once
 *    and replayed until the batch set, pipeline mode or bound groups change;
 *  - batches that are not plain opaque whole draws under the current state
 *    (partly hidden, X-Ray, transparent, evicted, split) stay on the legacy
 *    per-frame path, so correctness falls back instead of breaking.
 *
 * Off by default; enabled through `Renderer.setDrawStreamConfig` (`draw-stream-config.ts`).
 */
import type { BatchedMesh } from './types.js';
import type { RenderPipeline } from './pipeline.js';
import type { OpaqueDrawMode } from './opaque-draw-variants.js';
import type { RelativeToEyeFrame } from './relative-to-eye.js';
import { MESH_UNIFORM_BYTES, MESH_UNIFORM_FLOATS, MESH_UNIFORM_OFFSET } from './mesh-rte-uniforms.js';
import { emptyBindGroup, sectionExclusions } from './section-exclusions.js';
import { STREAM_DELTA_FLOATS, STREAM_RECORD_FLOATS } from './shaders/main-stream.wgsl.js';
import { packMeshMaterial } from './mesh-material.js';
import { HlodTree, type HlodNode } from './draw-stream-hlod.js';
import { GeometryArena } from './draw-stream-arena.js';
import { StreamPipelines } from './draw-stream-pipelines.js';
import { buildStreamNodes, linkHlodLeaves, type HlodLinks } from './draw-stream-nodes.js';
import { collectStreamItems, StreamDrawBudget } from './draw-stream-cull.js';
import { cellOf, idOf, modeIndex, type StreamBatchState, type StreamFrameInputs, type StreamFrameStats, type StreamItem, type StreamNode } from './draw-stream-types.js';
import type { DrawStreamConfig } from './draw-stream-config.js';
import type { MeshData } from '@ifc-lite/geometry';

export type { StreamBatchState, StreamFrameInputs, StreamFrameStats } from './draw-stream-types.js';

const RECORD_BYTES = STREAM_RECORD_FLOATS * 4;
/** First-sight bundle recordings allowed per frame; the rest draw directly. */
const RECORD_PER_FRAME = 32;
/** Bundles pre-recorded per frame in the background (see `prewarm`). */
const PREWARM_PER_FRAME = 24;
const DELTA_BYTES = STREAM_DELTA_FLOATS * 4;

export class DrawStream {
  members: BatchedMesh[] = [];
  legacy: BatchedMesh[] = [];
  private nodes: StreamNode[] = [];
  private key = '';
  private frameBuffer: GPUBuffer;
  private recordBuffer: GPUBuffer | null = null;
  private deltaBuffer: GPUBuffer | null = null;
  private deltaImage = new Float32Array(0);
  private bindGroup: GPUBindGroup | null = null;
  private readonly pipelines: StreamPipelines;
  private lastCamera: [number, number, number] = [NaN, NaN, NaN];
  private bundleKey = '';
  private readonly scratch = new Float32Array(MESH_UNIFORM_FLOATS);
  private hlod: HlodTree | null = null;
  private geomKey = '';
  private hlodBindGroup: GPUBindGroup | null = null;
  private hlodGeneration = -1;
  private links: HlodLinks = { leavesByParent: new Map(), uncovered: [], dirty: new Set() };
  private requestRender: () => void = () => {};
  private arena: GeometryArena | null = null;
  private readonly budget = new StreamDrawBudget();
  private orthoKey = '';
  private prewarmCursor = 0;
  private altPrewarmCursor = 0;
  private syncCount = 0;
  private invalidationCount = 0;

  constructor(private readonly device: GPUDevice, private readonly pipeline: RenderPipeline, readonly config: DrawStreamConfig) {
    this.frameBuffer = device.createBuffer({ label: 'draw-stream-frame', size: MESH_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.pipelines = new StreamPipelines(device, pipeline);
  }

  /**
   * Rebuild membership, records and nodes when `key` (batch set + visibility,
   * override and X-Ray epochs) changed. `eligible` returns the batch's state
   * when it can be drawn as a plain opaque whole batch, else null (legacy).
   */
  sync(batches: readonly BatchedMesh[], geomKey: string, key: string, cell: number, eligible: (b: BatchedMesh) => StreamBatchState | null,
    forEachPiece?: (visit: (m: MeshData) => void) => void, requestRender?: () => void): boolean {
    if (requestRender) this.requestRender = requestRender;
    if (key === this.key && geomKey === this.geomKey) return false;
    this.key = key; this.syncCount++;
    const leafCell = cell > 0 ? cell : 32;
    if (this.config.hlod && forEachPiece && geomKey !== this.geomKey) {
      this.hlod?.destroy();
      this.hlod = new HlodTree(this.device, leafCell, this.config.hlodGrid, () => this.requestRender());
      this.hlod.build(forEachPiece);
    }
    if (this.config.arena && geomKey !== this.geomKey) {
      this.arena?.destroy();
      const cellKey = (b: BatchedMesh): string => (b.bounds ? cellOf(b.bounds.min, b.bounds.max, leafCell).join(',') : '-');
      this.arena = GeometryArena.build(this.device, batches, cellKey);
      if (!this.arena) console.warn('[draw-stream] arena unavailable: batch buffers lack COPY_SRC (enable the arena before geometry loads)');
    }
    this.geomKey = geomKey;
    const members: BatchedMesh[] = []; const legacy: BatchedMesh[] = []; const states: StreamBatchState[] = [];
    for (const b of batches) {
      // An evicted batch the arena holds still draws from its arena copy.
      const st = b.bounds && (b.gpuResident !== false || this.arena?.slots.has(b)) ? eligible(b) : null;
      if (st) { members.push(b); states.push(st); } else legacy.push(b);
    }
    this.members = members; this.legacy = legacy;
    this.writeRecords(states);
    this.nodes = buildStreamNodes(members, leafCell);
    this.links = linkHlodLeaves(this.hlod, this.nodes, legacy, members, states, leafCell);
    this.lastCamera = [NaN, NaN, NaN];
    return true;
  }

  private writeRecords(states: StreamBatchState[]): void {
    const n = Math.max(1, this.members.length);
    if (!this.recordBuffer || this.recordBuffer.size < n * RECORD_BYTES) {
      this.recordBuffer?.destroy(); this.deltaBuffer?.destroy();
      const cap = Math.ceil(n * 1.25);
      this.recordBuffer = this.device.createBuffer({ label: 'draw-stream-records', size: cap * RECORD_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.deltaBuffer = this.device.createBuffer({ label: 'draw-stream-deltas', size: cap * DELTA_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.bindGroup = null;
    }
    const img = new Float32Array(n * STREAM_RECORD_FLOATS); const u32 = new Uint32Array(img.buffer);
    const t = this.scratch; const mr = MESH_UNIFORM_OFFSET.metallicRoughness;
    for (let i = 0; i < this.members.length; i++) {
      const b = this.members[i]!; const st = states[i]!; const o = i * STREAM_RECORD_FLOATS;
      img[o] = b.color[0]; img[o + 1] = b.color[1]; img[o + 2] = b.color[2]; img[o + 3] = st.alpha;
      packMeshMaterial(t, b.color[3], b.finish);
      img[o + 4] = t[mr]!; img[o + 5] = t[mr + 1]!; img[o + 6] = t[mr + 2]!; img[o + 7] = t[mr + 3]!;
      const q = b.quantized;
      img[o + 8] = q ? q.min[0] : 0; img[o + 9] = q ? q.min[1] : 0; img[o + 10] = q ? q.min[2] : 0; img[o + 11] = q ? q.step : 0;
      const org = b.origin; img[o + 12] = org ? org[0] : 0; img[o + 13] = org ? org[1] : 0; img[o + 14] = org ? org[2] : 0;
      // overrideParams, as renderBatch packs them: x = anchor (or 0xFFFFFFFF), y = paint/emphasize bits
      u32[o + 16] = 0;
      u32[o + 17] = st.anchor ?? 0xFFFFFFFF;
      u32[o + 18] = st.overrideBits;
      u32[o + 19] = 0;
    }
    this.device.queue.writeBuffer(this.recordBuffer!, 0, img);
    this.deltaImage = new Float32Array(n * STREAM_DELTA_FLOATS);
  }

  /** Leaves drawn by the last `encode`, whose member batches count as drawn for GPU residency. */
  private readonly drawnLeaves: StreamNode[] = [];

  /**
   * Visit every batch the last `encode` drew (leaf members; proxies stand in for, and
   * do not keep warm, the batches below them). The residency budget evicts
   * least-recently-drawn batches: without this, every stream-drawn batch looked
   * never drawn, was evicted, fell back to legacy and forced a resync.
   */
  forEachDrawnBatch(visit: (b: BatchedMesh) => void): void {
    for (const leaf of this.drawnLeaves) for (const i of leaf.members) { const b = this.members[i]; if (b) visit(b); }
  }

  /** Write the frame uniform and, when the camera moved, every member's origin delta. */
  prepareFrame(frameUniforms: Float32Array, rte: RelativeToEyeFrame): void {
    this.device.queue.writeBuffer(this.frameBuffer, 0, frameUniforms);
    const cam = rte.getCameraWorld();
    this.hlod?.prepareFrame(rte);
    if (cam[0] === this.lastCamera[0] && cam[1] === this.lastCamera[1] && cam[2] === this.lastCamera[2]) return;
    this.lastCamera = [cam[0], cam[1], cam[2]];
    const d = this.deltaImage; const zero: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < this.members.length; i++) {
      // drawableDeltaHigh at +0, drawableDeltaLow at +4: the legacy uniform layout
      rte.tryPackDrawableOrigin(this.members[i]!.origin ?? zero, d, i * STREAM_DELTA_FLOATS);
    }
    if (this.members.length) this.device.queue.writeBuffer(this.deltaBuffer!, 0, d, 0, this.members.length * STREAM_DELTA_FLOATS);
  }

  private ensureBindGroup(): GPUBindGroup {
    return this.bindGroup ??= this.device.createBindGroup({ label: 'draw-stream-bg', layout: this.pipelines.bindGroupLayout, entries: [
      { binding: 0, resource: { buffer: this.frameBuffer } },
      { binding: 1, resource: { buffer: this.recordBuffer! } },
      { binding: 2, resource: { buffer: this.deltaBuffer! } },
    ] });
  }

  /** Encode the member draws of one node into `enc` (a pass or a bundle encoder). */
  private encodeNode(enc: GPURenderPassEncoder | GPURenderBundleEncoder, node: StreamNode, lod1: boolean, mode: OpaqueDrawMode, bindAll: boolean,
    map: (p: GPURenderPipeline) => GPURenderPipeline = (p) => p, group2?: GPUBindGroup): number {
    let bound: GPURenderPipeline | null = null; let draws = 0;
    if (bindAll) {
      enc.setBindGroup(0, this.ensureBindGroup());
      enc.setBindGroup(1, this.pipeline.getEnvironmentBindGroup());
      enc.setBindGroup(2, group2 ?? emptyBindGroup(this.device));
      enc.setBindGroup(3, sectionExclusions(this.device).bindGroup);
    }
    let vb: GPUBuffer | null = null; let ib: GPUBuffer | null = null;
    for (const i of node.members) {
      const b = this.members[i]!;
      const p = map(this.pipelines.get(!!b.quantized, mode));
      if (p !== bound) { enc.setPipeline(p); bound = p; vb = null; ib = null; if (!bindAll) enc.setBindGroup(0, this.ensureBindGroup()); }
      const slot = this.arena?.slots.get(b);
      if (slot) {
        // shared arena: draws differ only in offsets
        if (slot.vertexBuffer !== vb) { enc.setVertexBuffer(0, slot.vertexBuffer); vb = slot.vertexBuffer; }
        if (slot.indexBuffer !== ib) { enc.setIndexBuffer(slot.indexBuffer, 'uint32'); ib = slot.indexBuffer; }
        if (lod1 && slot.count1 > 0) enc.drawIndexed(slot.count1, 1, slot.first1, slot.baseVertex, i);
        else enc.drawIndexed(slot.count0, 1, slot.first0, slot.baseVertex, i);
        draws++;
        continue;
      }
      vb = null; ib = null;
      enc.setVertexBuffer(0, b.vertexBuffer);
      if (lod1 && b.lod1IndexBuffer && b.lod1IndexCount) { enc.setIndexBuffer(b.lod1IndexBuffer, 'uint32'); enc.drawIndexed(b.lod1IndexCount, 1, 0, 0, i); }
      else { enc.setIndexBuffer(b.indexBuffer, 'uint32'); enc.drawIndexed(b.indexCount, 1, 0, 0, i); }
      draws++;
    }
    return draws;
  }

  /** Cull nodes, sort them front to back, and draw (bundles where allowed). */
  encode(f: StreamFrameInputs): StreamFrameStats {
    const h = this.hlod;
    const stats: StreamFrameStats = { nodes: this.nodes.length, nodesDrawn: 0, draws: 0, tris: 0, bundlesRecorded: 0, entries: 0, syncs: this.syncCount, invalidations: this.invalidationCount, arenaBytes: this.arena?.bytes ?? 0, budgetDraws: 0, budgetCut: 0,
      proxiesDrawn: 0, proxyReady: h?.stats.ready ?? 0, proxyNodes: h?.stats.nodes ?? 0, proxyBuildMs: h?.stats.buildMs ?? 0, proxyBytes: h?.stats.proxyBytes ?? 0 };
    this.drawnLeaves.length = 0;
    if (this.members.length === 0) return stats;
    const bg = this.ensureBindGroup();
    // Bundles are cached per draw mode: the viewer's effects governor toggles edges (object-id
    // writes) while navigating, and invalidating on every flip re-recorded everything.
    const mi = modeIndex(f.mode);
    const bundleKey = `${idOf(this.pipeline.getEnvironmentBindGroup())}|${idOf(sectionExclusions(this.device).bindGroup)}|${idOf(bg)}`;
    const keyChanged = bundleKey !== this.bundleKey, hlodChanged = h !== null && h.generation !== this.hlodGeneration;
    if (keyChanged) { this.bundleKey = bundleKey; this.invalidationCount++; for (const n of this.nodes) n.bundles.fill(null); }
    if (hlodChanged) { this.hlodGeneration = h.generation; this.hlodBindGroup = null; }
    if (h && (keyChanged || hlodChanged)) for (const l of h.levels) if (l) for (const n of l.values()) n.bundle.fill(null);
    const items = collectStreamItems(f, this.nodes, h, this.links, this.config.hlodPx);
    this.budget.apply(items, this.config.budgetMs, f.interacting, stats);
    items.sort((a, b) => a.d - b.d);
    for (const it of items) if (it.leaf) this.drawnLeaves.push(it.leaf);
    if (f.ortho && this.config.bundles) { this.encodeOrtho(f, items, stats); return stats; }
    const useBundles = this.config.bundles && f.allowBundles;
    const bundles: GPURenderBundle[] = [];
    const base = this.pipeline.getStreamBase();
    const newBundle = (): GPURenderBundleEncoder => this.device.createRenderBundleEncoder({ label: 'draw-stream-node', colorFormats: [base.colorFormat, 'rgba8unorm'], depthStencilFormat: base.depthFormat, sampleCount: base.sampleCount });
    // At most RECORD_PER_FRAME first-sight recordings per frame. A node past the cap
    // draws directly this frame (≈0.1 ms for a 30-draw node vs ≈0.9 ms to record its bundle)
    // and prewarm records it later, so a camera move onto hundreds of unseen nodes right after
    // HLOD converges no longer records them all at once (a 395 ms frame in the huge-geometry campaign).
    let recordBudget = RECORD_PER_FRAME;
    const direct: StreamItem[] = [];
    for (const it of items) {
      if (it.proxy) {
        const n = it.proxy;
        stats.proxiesDrawn++; stats.draws += n.draws.length; stats.tris += n.tris;
        if (!useBundles) { this.encodeProxy(f.pass, n, f.mode, false); continue; }
        let pb = n.bundle[mi];
        if (!pb) {
          if (recordBudget <= 0) { direct.push(it); continue; }
          const enc = newBundle(); this.encodeProxy(enc, n, f.mode, true); pb = enc.finish(); n.bundle[mi] = pb; stats.bundlesRecorded++; recordBudget--;
        }
        bundles.push(pb);
        continue;
      }
      const v = it;
      stats.nodesDrawn++; stats.draws += v.leaf.members.length; stats.tris += v.lod1 ? v.leaf.tris1 : v.leaf.tris0; stats.entries += v.leaf.entries;
      if (!useBundles) { this.encodeNode(f.pass, v.leaf, v.lod1, f.mode, false); continue; }
      const slot = mi * 2 + (v.lod1 ? 1 : 0);
      let bundle = v.leaf.bundles[slot];
      if (!bundle) {
        if (recordBudget <= 0) { direct.push(it); continue; }
        const enc = newBundle();
        this.encodeNode(enc, v.leaf, v.lod1, f.mode, true);
        bundle = enc.finish(); v.leaf.bundles[slot] = bundle; stats.bundlesRecorded++; recordBudget--;
      }
      bundles.push(bundle);
    }
    if (bundles.length) f.pass.executeBundles(bundles);
    // Bundles reset pass state; direct nodes bind everything themselves.
    for (const it of direct) {
      if (it.proxy) this.encodeProxy(f.pass, it.proxy, f.mode, true);
      else this.encodeNode(f.pass, it.leaf, it.lod1, f.mode, true);
    }
    stats.directNodes = direct.length;
    if (useBundles) this.prewarm(newBundle, f.mode, stats);
    return stats;
  }

  /**
   * Record a few not-yet-recorded bundles per frame (both LODs of every leaf,
   * every ready proxy) so a camera move does not record hundreds at once on
   * the frame that first sees them (the campus x2 p99 spike).
   */
  private prewarm(newBundle: () => GPURenderBundleEncoder, mode: OpaqueDrawMode, stats: StreamFrameStats): void {
    let budget = PREWARM_PER_FRAME;
    const leaves = this.nodes.length;
    const mi = modeIndex(mode);
    for (let scanned = 0; budget > 0 && scanned < leaves * 2; scanned++) {
      const k = this.prewarmCursor++ % (leaves * 2);
      const node = this.nodes[k >> 1]!; const slot = mi * 2 + (k & 1);
      if (node.bundles[slot]) continue;
      const enc = newBundle(); this.encodeNode(enc, node, (k & 1) === 1, mode, true); node.bundles[slot] = enc.finish(); budget--; stats.bundlesRecorded++;
    }
    if (this.hlod && budget > 0) {
      for (const l of this.hlod.levels) {
        if (!l || budget <= 0) continue;
        for (const n of l.values()) {
          if (budget <= 0) break;
          if (n.state !== 'ready' || n.bundle[mi]) continue;
          const enc = newBundle(); this.encodeProxy(enc, n, mode, true); n.bundle[mi] = enc.finish(); budget--; stats.bundlesRecorded++;
        }
      }
    }
    // Once this mode is warm, warm the other discard mode too. A section plane (or a
    // translucent override) flips the opaque pass to the discarding variant, and its first frame
    // otherwise recorded or directly encoded every visible node (section toggle 38 -> 134 ms).
    if (budget > 0) {
      const alt: OpaqueDrawMode = { ...mode, discardFree: !mode.discardFree };
      const ai = modeIndex(alt);
      for (let scanned = 0; budget > 0 && scanned < leaves * 2; scanned++) {
        const k = this.altPrewarmCursor++ % (leaves * 2);
        const node = this.nodes[k >> 1]!; const slot = ai * 2 + (k & 1);
        if (node.bundles[slot]) continue;
        const enc = newBundle(); this.encodeNode(enc, node, (k & 1) === 1, alt, true); node.bundles[slot] = enc.finish(); budget--; stats.bundlesRecorded++;
      }
    }
  }

  /**
   * Orthographic: the legacy path replays every opaque draw, with all its
   * state, into a geometric-depth prepass through a proxied pass. Here each
   * node records a depth bundle (depth variant, unbiased) and a colour bundle
   * (guarded colour variant + the visibility binding) once, and the frame
   * replays both lists: the prepass folds into the same stream.
   */
  private encodeOrtho(f: StreamFrameInputs, items: readonly StreamItem[], stats: StreamFrameStats): void {
    const vis = f.ortho!;
    const binding = vis.getBinding();
    if (!binding) return;
    const key = `${this.bundleKey}|${idOf(binding)}`;
    if (key !== this.orthoKey) {
      this.orthoKey = key;
      for (const n of this.nodes) n.ortho = [null, null, null, null];
      if (this.hlod) for (const l of this.hlod.levels) if (l) for (const n of l.values()) n.ortho = [null, null];
    }
    const base = this.pipeline.getStreamBase();
    const colourEnc = (): GPURenderBundleEncoder => this.device.createRenderBundleEncoder({ label: 'draw-stream-ortho-colour', colorFormats: [base.colorFormat, 'rgba8unorm'], depthStencilFormat: base.depthFormat, sampleCount: base.sampleCount });
    const depthEnc = (): GPURenderBundleEncoder => this.device.createRenderBundleEncoder({ label: 'draw-stream-ortho-depth', colorFormats: [], depthStencilFormat: 'depth32float', sampleCount: vis.sampleCount() });
    const colourOf = (p: GPURenderPipeline): GPURenderPipeline => vis.variantsOf(p)?.colour ?? p;
    const depthOf = (p: GPURenderPipeline): GPURenderPipeline => { const d = vis.variantsOf(p)?.depth; if (!d) throw new Error('draw stream: orthographic depth variant missing'); return d; };
    const colour: GPURenderBundle[] = []; const depth: GPURenderBundle[] = [];
    for (const it of items) {
      if (it.proxy) {
        const n = it.proxy; stats.proxiesDrawn++; stats.draws += n.draws.length; stats.tris += n.tris;
        if (!n.ortho[0]) { const e = colourEnc(); this.encodeProxy(e, n, f.mode, true, colourOf, binding); n.ortho[0] = e.finish(); stats.bundlesRecorded++; }
        if (!n.ortho[1]) { const e = depthEnc(); this.encodeProxy(e, n, f.mode, true, depthOf); n.ortho[1] = e.finish(); }
        colour.push(n.ortho[0]); depth.push(n.ortho[1]);
        continue;
      }
      const leaf = it.leaf; const lod1 = it.lod1; const o = lod1 ? 2 : 0;
      stats.nodesDrawn++; stats.draws += leaf.members.length; stats.tris += lod1 ? leaf.tris1 : leaf.tris0; stats.entries += leaf.entries;
      if (!leaf.ortho[o]) { const e = colourEnc(); this.encodeNode(e, leaf, lod1, f.mode, true, colourOf, binding); leaf.ortho[o] = e.finish(); stats.bundlesRecorded++; }
      if (!leaf.ortho[o + 1]) { const e = depthEnc(); this.encodeNode(e, leaf, lod1, f.mode, true, depthOf); leaf.ortho[o + 1] = e.finish(); }
      colour.push(leaf.ortho[o]!); depth.push(leaf.ortho[o + 1]!);
    }
    vis.executeStreamBundles(colour, depth);
  }

  private encodeProxy(enc: GPURenderPassEncoder | GPURenderBundleEncoder, n: HlodNode, mode: OpaqueDrawMode, bindAll: boolean,
    map: (p: GPURenderPipeline) => GPURenderPipeline = (p) => p, group2?: GPUBindGroup): void {
    const h = this.hlod!;
    const iota = h.iotaBuffer(); if (!iota || !h.recordBuffer || !h.deltaBuffer) return;
    this.hlodBindGroup ??= this.device.createBindGroup({ label: 'draw-stream-proxy-bg', layout: this.pipelines.bindGroupLayout, entries: [
      { binding: 0, resource: { buffer: this.frameBuffer } },
      { binding: 1, resource: { buffer: h.recordBuffer } },
      { binding: 2, resource: { buffer: h.deltaBuffer } },
    ] });
    enc.setPipeline(map(this.pipelines.get(false, mode)));
    enc.setBindGroup(0, this.hlodBindGroup);
    if (bindAll) {
      enc.setBindGroup(1, this.pipeline.getEnvironmentBindGroup());
      enc.setBindGroup(2, group2 ?? emptyBindGroup(this.device));
      enc.setBindGroup(3, sectionExclusions(this.device).bindGroup);
    }
    enc.setIndexBuffer(iota, 'uint32');
    let vb: GPUBuffer | null = null;
    for (const d of n.draws) { if (d.vertexBuffer !== vb) { enc.setVertexBuffer(0, d.vertexBuffer); vb = d.vertexBuffer; } enc.drawIndexed(d.count, 1, 0, d.baseVertex, d.record); }
  }

  destroy(): void {
    this.frameBuffer.destroy(); this.recordBuffer?.destroy(); this.deltaBuffer?.destroy();
    this.nodes = []; this.members = []; this.legacy = []; this.pipelines.clear();
    this.hlod?.destroy(); this.hlod = null; this.arena?.destroy(); this.arena = null;
  }
}

