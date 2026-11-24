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
 *  - batches are grouped into spatial nodes (one per chunk cell). Members are
 *    culled and LOD-picked per batch like the legacy loop; a node whose members
 *    agree replays its pre-recorded bundle (LOD0 or LOD1), kept until the batch
 *    set, pipeline mode or bound groups change, and a mixed node draws directly;
 *  - batches that are not plain opaque whole draws (partly hidden, X-Ray,
 *    transparent, evicted, split) stay on the legacy path. Off by default
 *    (`Renderer.setDrawStreamConfig`, `draw-stream-config.ts`).
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
import { collectStreamItems, mixedBundles, pickedLoad, StreamDrawBudget } from './draw-stream-cull.js';
import { cellOf, idOf, MemberPick, modeIndex, orthoSlot, type StreamBatchState, type StreamFrameInputs, type StreamFrameStats, type StreamItem, type StreamNode } from './draw-stream-types.js';
import type { DrawStreamConfig } from './draw-stream-config.js';
import { DEFAULT_CHUNK_CELL_SIZE } from './chunk-grid.js';
import type { MeshData } from '@ifc-lite/geometry';

export type { StreamBatchState, StreamFrameInputs, StreamFrameStats } from './draw-stream-types.js';

const RECORD_BYTES = STREAM_RECORD_FLOATS * 4, DELTA_BYTES = STREAM_DELTA_FLOATS * 4;
/** First-sight bundle recordings allowed per frame (the rest draw directly), and bundles pre-recorded per frame (`prewarm`). */
const RECORD_PER_FRAME = 32, PREWARM_PER_FRAME = 24;

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
  /** Members the eye envelope rejected: they stay on the legacy path, which skips them. */
  private readonly outsideEnvelope = new Set<BatchedMesh>();
  /** Leaves holding such a member, not drawn until the resync hands it back. */
  private readonly skipLeaves = new Set<StreamNode>();
  private links: HlodLinks = { leavesByParent: new Map(), uncovered: [], dirty: new Set(), allDirty: false };
  private requestRender: () => void = () => {};
  private arena: GeometryArena | null = null;
  private readonly budget = new StreamDrawBudget();
  private orthoKey = '';
  /** Prewarm resume positions: this frame's mode, and the other discard mode. */
  private readonly prewarmCursors = [0, 0];
  /** Per mode index: prewarm found nothing left to record (cleared on any invalidation). */
  private readonly warmModes = [false, false, false, false];
  private warmReady = 0;
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
    this.key = key; this.syncCount++; this.warmModes.fill(false);
    const leafCell = cell > 0 ? cell : DEFAULT_CHUNK_CELL_SIZE;
    if (this.config.hlod && forEachPiece && geomKey !== this.geomKey) {
      this.hlod?.destroy();
      this.hlod = new HlodTree(this.device, leafCell, this.config.hlodGrid, () => this.requestRender());
      this.hlodGeneration = -1; this.hlodBindGroup = null; this.orthoKey = ''; this.hlod.build(forEachPiece); // a new tree restarts its generations
    }
    if (this.config.arena && geomKey !== this.geomKey) {
      this.arena?.destroy();
      const cellKey = (b: BatchedMesh): string => (b.bounds ? cellOf(b.bounds.min, b.bounds.max, leafCell).join(',') : '-');
      this.arena = GeometryArena.build(this.device, batches, cellKey);
      if (!this.arena) console.warn('[draw-stream] arena unavailable: batch buffers lack COPY_SRC (enable the arena before geometry loads)');
    }
    if (geomKey !== this.geomKey) this.outsideEnvelope.clear();
    this.geomKey = geomKey;
    const members: BatchedMesh[] = []; const legacy: BatchedMesh[] = []; const states: StreamBatchState[] = [];
    for (const b of batches) {
      // An evicted batch the arena holds still draws from its arena copy.
      const st = b.bounds && (b.gpuResident !== false || this.arena?.slots.has(b)) && !this.outsideEnvelope.has(b) ? eligible(b) : null;
      if (st) { members.push(b); states.push(st); } else legacy.push(b);
    }
    this.members = members; this.legacy = legacy;
    this.writeRecords(states);
    this.nodes = buildStreamNodes(members, leafCell); this.skipLeaves.clear();
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

  /** Write the frame uniform and, when the camera moved, every member's origin delta. */
  prepareFrame(frameUniforms: Float32Array, rte: RelativeToEyeFrame): void {
    this.device.queue.writeBuffer(this.frameBuffer, 0, frameUniforms);
    const cam = rte.getCameraWorld();
    this.hlod?.prepareFrame(rte);
    if (cam[0] === this.lastCamera[0] && cam[1] === this.lastCamera[1] && cam[2] === this.lastCamera[2]) return;
    this.lastCamera = [cam[0], cam[1], cam[2]];
    const d = this.deltaImage; const zero: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < this.members.length; i++) {
      // drawableDeltaHigh at +0, drawableDeltaLow at +4: the legacy uniform layout. A member outside
      // the eye envelope is skipped by the legacy path: hand it back to it (resync) and skip its leaf now.
      if (!rte.tryPackDrawableOrigin(this.members[i]!.origin ?? zero, d, i * STREAM_DELTA_FLOATS)) { this.outsideEnvelope.add(this.members[i]!); this.key = ''; }
    }
    if (this.key === '') for (const n of this.nodes) if (n.members.some((i) => this.outsideEnvelope.has(this.members[i]!))) this.skipLeaves.add(n);
    if (this.members.length) this.device.queue.writeBuffer(this.deltaBuffer!, 0, d, 0, this.members.length * STREAM_DELTA_FLOATS);
  }

  private ensureBindGroup(): GPUBindGroup {
    return this.bindGroup ??= this.device.createBindGroup({ label: 'draw-stream-bg', layout: this.pipelines.bindGroupLayout, entries: [
      { binding: 0, resource: { buffer: this.frameBuffer } },
      { binding: 1, resource: { buffer: this.recordBuffer! } },
      { binding: 2, resource: { buffer: this.deltaBuffer! } },
    ] });
  }

  /** Encode the member draws of one node into `enc` (a pass or a bundle encoder), all at one LOD or per member (`MemberPick`s). */
  private encodeNode(enc: GPURenderPassEncoder | GPURenderBundleEncoder, node: StreamNode, lod: boolean | Uint8Array, mode: OpaqueDrawMode, bindAll: boolean,
    map: (p: GPURenderPipeline) => GPURenderPipeline = (p) => p, group2?: GPUBindGroup): number {
    let bound: GPURenderPipeline | null = null; let draws = 0;
    if (bindAll) { enc.setBindGroup(0, this.ensureBindGroup()); this.bindFrameGroups(enc, group2); }
    let vb: GPUBuffer | null = null; let ib: GPUBuffer | null = null;
    for (let k = 0; k < node.members.length; k++) {
      const i = node.members[k]!, b = this.members[i]!;
      if (typeof lod !== 'boolean' && lod[k] === MemberPick.Cull) continue;
      const lod1 = typeof lod === 'boolean' ? lod : lod[k] === MemberPick.Lod1;
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

  /**
   * Cull, sort front to back and draw (bundles where allowed). `drawn` visits every drawn member (not the batches
   * under a proxy): the residency budget evicts least-recently-drawn batches, so stream draws must count.
   */
  encode(f: StreamFrameInputs, drawn: (b: BatchedMesh) => void): StreamFrameStats {
    const h = this.hlod;
    const stats: StreamFrameStats = { nodes: this.nodes.length, nodesDrawn: 0, draws: 0, tris: 0, bundlesRecorded: 0, entries: 0, syncs: this.syncCount, invalidations: this.invalidationCount, arenaBytes: this.arena?.bytes ?? 0, budgetDraws: 0, budgetCut: 0,
      proxiesDrawn: 0, proxyReady: h?.stats.ready ?? 0, proxyNodes: h?.stats.nodes ?? 0, proxyBuildMs: h?.stats.buildMs ?? 0, proxyBytes: h?.stats.proxyBytes ?? 0 };
    if (this.members.length === 0) return stats;
    const bg = this.ensureBindGroup();
    // Bundles are cached per draw mode: the viewer's effects governor toggles edges (object-id
    // writes) while navigating, and invalidating on every flip re-recorded everything.
    const mi = modeIndex(f.mode);
    const bundleKey = `${idOf(this.pipeline.getEnvironmentBindGroup())}|${idOf(sectionExclusions(this.device).bindGroup)}|${idOf(bg)}`;
    const keyChanged = bundleKey !== this.bundleKey, hlodChanged = h !== null && h.generation !== this.hlodGeneration;
    if (keyChanged) { this.bundleKey = bundleKey; this.invalidationCount++; for (const n of this.nodes) n.bundles.fill(null); }
    if (hlodChanged) { this.hlodGeneration = h.generation; this.hlodBindGroup = null; }
    if (keyChanged || hlodChanged) { if (h) for (const n of h.nodes()) n.bundle.fill(null); this.warmModes.fill(false); }
    let items = collectStreamItems(f, this.nodes, h, this.links, this.config.hlodPx, this.members);
    if (this.skipLeaves.size) items = items.filter((it) => !it.leaf || !this.skipLeaves.has(it.leaf));
    this.budget.apply(items, this.config.budgetMs, f.interacting, stats);
    items.sort((a, b) => a.d - b.d);
    for (const it of items) if (it.leaf) for (let k = 0; k < it.leaf.members.length; k++) if (it.picks?.[k] !== MemberPick.Cull) drawn(this.members[it.leaf.members[k]!]!);
    if (f.ortho?.capturing() && this.config.bundles) { this.encodeOrtho(f, items, stats); return stats; } // else uncaptured: draw directly
    const useBundles = this.config.bundles && f.allowBundles;
    const bundles: GPURenderBundle[] = [];
    const newBundle = (): GPURenderBundleEncoder => this.bundleEncoder('draw-stream-node');
    // At most RECORD_PER_FRAME first-sight recordings per frame. A node past the cap draws directly this
    // frame (≈0.1 ms for a 30-draw node vs ≈0.9 ms to record its bundle) and prewarm records it later, so a
    // camera move onto hundreds of unseen nodes no longer records them all at once (a 395 ms frame).
    let recordBudget = RECORD_PER_FRAME, directNodes = 0;
    // A direct node flushes the bundles sorted before it, keeping front-to-back order (bundles reset pass state: it binds everything).
    const direct = (draw: () => void): void => { if (bundles.length) { f.pass.executeBundles(bundles); bundles.length = 0; } draw(); directNodes++; };
    for (const it of items) {
      if (it.proxy) {
        const n = it.proxy;
        stats.proxiesDrawn++; stats.draws += n.draws.length; stats.tris += n.tris;
        if (!useBundles) { this.encodeProxy(f.pass, n, f.mode, false); continue; }
        let pb = n.bundle[mi];
        if (!pb) {
          if (recordBudget <= 0) { direct(() => this.encodeProxy(f.pass, n, f.mode, true)); continue; }
          const enc = newBundle(); this.encodeProxy(enc, n, f.mode, true); pb = enc.finish(); n.bundle[mi] = pb; stats.bundlesRecorded++; recordBudget--;
        }
        bundles.push(pb);
        continue;
      }
      const v = it, lod = v.picks ?? v.lod1, slot = mi * 2 + (v.lod1 ? 1 : 0);
      const load = v.picks ? pickedLoad(v.leaf, v.picks, this.members) : { draws: v.leaf.members.length, tris: v.lod1 ? v.leaf.tris1 : v.leaf.tris0 };
      stats.nodesDrawn++; stats.draws += load.draws; stats.tris += load.tris; stats.entries += v.leaf.entries;
      if (!useBundles) { this.encodeNode(f.pass, v.leaf, lod, f.mode, false); continue; }
      // Members at different LODs: one bundle per node for the last pick pattern (stable while the camera rests).
      const mixedKey = `${this.bundleKey}|${mi}`;
      let bundle = v.picks ? mixedBundles(v.leaf, mixedKey, v.picks)?.[0] ?? null : v.leaf.bundles[slot];
      if (!bundle) {
        if (recordBudget <= 0) { direct(() => this.encodeNode(f.pass, v.leaf, lod, f.mode, true)); continue; }
        const enc = newBundle(); this.encodeNode(enc, v.leaf, lod, f.mode, true); bundle = enc.finish(); stats.bundlesRecorded++; recordBudget--;
        if (v.picks) v.leaf.mixed = { key: mixedKey, picks: v.picks, bundles: [bundle] }; else v.leaf.bundles[slot] = bundle;
      }
      bundles.push(bundle);
    }
    if (bundles.length) f.pass.executeBundles(bundles);
    stats.directNodes = directNodes;
    if (useBundles) this.prewarm(newBundle, f.mode, stats);
    return stats;
  }

  /** Record a few missing bundles per frame (both LODs of every leaf, every ready proxy): no camera move records hundreds at once (campus x2 p99). */
  private prewarm(newBundle: () => GPURenderBundleEncoder, mode: OpaqueDrawMode, stats: StreamFrameStats): void {
    const mi = modeIndex(mode);
    const ready = this.hlod?.stats.ready ?? 0; // a proxy turning ready adds a bundle to record
    if (ready !== this.warmReady) { this.warmReady = ready; this.warmModes.fill(false); }
    if (this.warmModes[mi]) return; // every slot this prewarm covers is recorded: skip the scans
    let budget = this.warmLeaves(newBundle, mode, PREWARM_PER_FRAME, 0, stats);
    if (this.hlod) {
      for (const n of this.hlod.nodes()) {
        if (budget <= 0) break;
        if (n.state !== 'ready' || n.bundle[mi]) continue;
        const enc = newBundle(); this.encodeProxy(enc, n, mode, true); n.bundle[mi] = enc.finish(); budget--; stats.bundlesRecorded++;
      }
    }
    // Once this mode is warm, warm the other discard mode too. A section plane (or a
    // translucent override) flips the opaque pass to the discarding variant, and its first frame
    // otherwise recorded or directly encoded every visible node (section toggle 38 -> 134 ms).
    if (budget > 0) budget = this.warmLeaves(newBundle, { ...mode, discardFree: !mode.discardFree }, budget, 1, stats);
    // Nothing left to record: stay idle until a resync, a bundle invalidation or a new ready proxy.
    if (budget === PREWARM_PER_FRAME) this.warmModes[mi] = true;
  }

  /** Record up to `budget` missing leaf bundles (both LODs) for `mode`, resuming at cursor `c`; returns the budget left. */
  private warmLeaves(newBundle: () => GPURenderBundleEncoder, mode: OpaqueDrawMode, budget: number, c: 0 | 1, stats: StreamFrameStats): number {
    const slots = this.nodes.length * 2; const mi = modeIndex(mode);
    for (let scanned = 0; budget > 0 && scanned < slots; scanned++) {
      const k = this.prewarmCursors[c]++ % slots;
      const node = this.nodes[k >> 1]!; const slot = mi * 2 + (k & 1);
      if (node.bundles[slot]) continue;
      const enc = newBundle(); this.encodeNode(enc, node, (k & 1) === 1, mode, true); node.bundles[slot] = enc.finish(); budget--; stats.bundlesRecorded++;
    }
    return budget;
  }

  /**
   * Orthographic: the legacy path replays every opaque draw, with all its
   * state, into a geometric-depth prepass through a proxied pass. Here each
   * node records a depth bundle (depth variant, unbiased) and a colour bundle
   * (guarded colour variant + the visibility binding) once, and the frame
   * replays both lists: the prepass folds into the same stream.
   */
  private encodeOrtho(f: StreamFrameInputs, items: readonly StreamItem[], stats: StreamFrameStats): void {
    const vis = f.ortho!, binding = vis.getBinding(), mi = modeIndex(f.mode);
    if (!binding) return;
    const key = `${this.bundleKey}|${idOf(binding)}|${this.hlodGeneration}`; // a new HLOD generation destroyed the buffers proxies bound
    if (key !== this.orthoKey) {
      this.orthoKey = key;
      for (const n of this.nodes) n.ortho = [];
      if (this.hlod) for (const n of this.hlod.nodes()) n.ortho = [];
    }
    const colourEnc = (): GPURenderBundleEncoder => this.bundleEncoder('draw-stream-ortho-colour');
    const depthEnc = (): GPURenderBundleEncoder => this.bundleEncoder('draw-stream-ortho-depth', { sampleCount: vis.sampleCount() });
    const colourOf = (p: GPURenderPipeline): GPURenderPipeline => vis.variantsOf(p)?.colour ?? p;
    const depthOf = (p: GPURenderPipeline): GPURenderPipeline => { const d = vis.variantsOf(p)?.depth; if (!d) throw new Error('draw stream: orthographic depth variant missing'); return d; };
    const colour: GPURenderBundle[] = []; const depth: GPURenderBundle[] = [];
    for (const it of items) {
      if (it.proxy) {
        const n = it.proxy; stats.proxiesDrawn++; stats.draws += n.draws.length; stats.tris += n.tris;
        const p = orthoSlot(mi, false);
        if (!n.ortho[p]) { const e = colourEnc(); this.encodeProxy(e, n, f.mode, true, colourOf, binding); n.ortho[p] = e.finish(); stats.bundlesRecorded++; }
        if (!n.ortho[p + 1]) { const e = depthEnc(); this.encodeProxy(e, n, f.mode, true, depthOf); n.ortho[p + 1] = e.finish(); }
        colour.push(n.ortho[p]!); depth.push(n.ortho[p + 1]!);
        continue;
      }
      const leaf = it.leaf; const lod1 = it.lod1; const o = orthoSlot(mi, lod1);
      const load = it.picks ? pickedLoad(leaf, it.picks, this.members) : { draws: leaf.members.length, tris: lod1 ? leaf.tris1 : leaf.tris0 };
      stats.nodesDrawn++; stats.draws += load.draws; stats.tris += load.tris; stats.entries += leaf.entries;
      if (it.picks) { // members at different LODs: one pair for the last pick pattern
        const key = `${this.orthoKey}|${mi}|ortho`;
        let pair = mixedBundles(leaf, key, it.picks);
        if (!pair) {
          const c = colourEnc(), d = depthEnc(); this.encodeNode(c, leaf, it.picks, f.mode, true, colourOf, binding); this.encodeNode(d, leaf, it.picks, f.mode, true, depthOf);
          pair = [c.finish(), d.finish()]; leaf.mixed = { key, picks: it.picks, bundles: pair }; stats.bundlesRecorded++;
        }
        colour.push(pair[0]!); depth.push(pair[1]!); continue;
      }
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
    if (bindAll) this.bindFrameGroups(enc, group2);
    enc.setIndexBuffer(iota, 'uint32');
    let vb: GPUBuffer | null = null;
    for (const d of n.draws) { if (d.vertexBuffer !== vb) { enc.setVertexBuffer(0, d.vertexBuffer); vb = d.vertexBuffer; } enc.drawIndexed(d.count, 1, 0, d.baseVertex, d.record); }
  }

  /** Groups 1-3 a bundle or a direct draw after a bundle replay must bind itself. */
  private bindFrameGroups(enc: GPURenderPassEncoder | GPURenderBundleEncoder, group2?: GPUBindGroup): void {
    enc.setBindGroup(1, this.pipeline.getEnvironmentBindGroup());
    enc.setBindGroup(2, group2 ?? emptyBindGroup(this.device));
    enc.setBindGroup(3, sectionExclusions(this.device).bindGroup);
  }

  private bundleEncoder(label: string, depthOnly?: { sampleCount: number }): GPURenderBundleEncoder {
    const base = this.pipeline.getStreamBase();
    return this.device.createRenderBundleEncoder(depthOnly
      ? { label, colorFormats: [], depthStencilFormat: 'depth32float', sampleCount: depthOnly.sampleCount }
      : { label, colorFormats: [base.colorFormat, 'rgba8unorm'], depthStencilFormat: base.depthFormat, sampleCount: base.sampleCount });
  }

  destroy(): void {
    this.frameBuffer.destroy(); this.recordBuffer?.destroy(); this.deltaBuffer?.destroy();
    this.nodes = []; this.members = []; this.legacy = []; this.pipelines.clear();
    this.hlod?.destroy(); this.hlod = null; this.arena?.destroy(); this.arena = null;
  }
}

