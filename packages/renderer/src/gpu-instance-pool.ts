/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU-driven instancing (off by default; `Renderer.setGpuInstancing`).
 *
 * The default instanced path keeps one vertex-rate instance buffer and one
 * camera-relative delta stream per template. A camera move repacks every
 * occurrence's f64 delta on the CPU (`instanced-rte.ts`), hide/select/colour
 * cost one `queue.writeBuffer` per occurrence, and culling is per template.
 *
 * This pool replaces those three costs with GPU tables and one compute pass:
 *
 * - SOURCE TABLES, written once per occurrence at upload (and again only when
 *   a placement moves it): the unchanged 88-byte instance record, and a
 *   32-byte cull record holding the canonical f64 anchor split into f32
 *   high/low parts, a bounding-sphere radius about that anchor and the
 *   occurrence's draw group.
 * - STATE TABLE, one u32 per occurrence: selected, hidden and dead bits plus a
 *   16-bit colour-palette index. Hide/isolate/select/recolour of any number of
 *   occurrences edits a CPU mirror and uploads the dirty span in ONE write.
 * - CULL PASS (compute, `gpu-instance-cull.ts`) compacts survivors per draw group
 *   (`gpu-instance-groups.ts`); a camera move writes one 192-byte uniform.
 *
 * The compacted streams have exactly the layout `INSTANCED_VERTEX_BUFFERS`
 * already reads (slot 1: 88-byte record, slot 2: 32-byte high/low split), so
 * the colour, pick and selection-mask shaders are unchanged: a draw binds the
 * group's region with a `setVertexBuffer` OFFSET and draws with
 * `firstInstance = 0`. That needs neither multi-draw-indirect (not on the web)
 * nor `indirect-first-instance` (missing on Firefox). The fallback cost is
 * one `drawIndexedIndirect` per draw group per pass, encoded on the CPU even
 * when the GPU found it empty.
 */

import { MAX_RTE_SOURCE_ABS_METRES } from './relative-to-eye.js';
import { INSTANCE_COLOR_OFFSET, INSTANCE_FLAGS_OFFSET, INSTANCE_FLAG_HIDDEN, INSTANCE_FLAG_SELECTED, INSTANCE_STRIDE_BYTES } from './instanced-render.js';
import { INSTANCED_RTE_DELTA_STRIDE_BYTES } from './instanced-rte.js';
import {
  ARGS_WORDS, CULL_BYTES, CULL_FLOATS, gpuInstanceCullWgsl, packCullParams, PARAMS_BYTES, POOL_STATE_PALETTE_SHIFT,
  POOL_STATE_DEAD, POOL_STATE_HIDDEN, POOL_STATE_SELECTED, POOL_VIEW_COLOUR, UNBOUNDED_RADIUS, WORKGROUP, type PoolCullParams, type PoolCullView,
} from './gpu-instance-cull.js';
import { ColourPalette, DrawGroups, FreeRanges, type PoolGeometry } from './gpu-instance-groups.js';

export { occurrenceSphereRadius, POOL_VIEW_COLOUR, POOL_VIEW_PICK, POOL_VIEW_SHADOW, type PoolCullView } from './gpu-instance-cull.js';


interface PoolTemplate {
  base: number;
  count: number;
  group: number;
  /** Bounding-sphere radius per occurrence about its anchor (rigid moves keep it). */
  radii: Float32Array;
}


/**
 * A pooled template's 16 B stand-in for its per-template instance records: the
 * pool holds the records and every pass draws from its compacted streams.
 */
export function poolStandInBuffer(device: GPUDevice): GPUBuffer {
  return device.createBuffer({ label: 'instanced-pool-standin', size: 16, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
}

export class GpuInstancePool {
  private readonly device: GPUDevice;
  private capacity = 0;
  private count = 0;
  private srcRecords: GPUBuffer | null = null;
  private srcCull: GPUBuffer | null = null;
  private stateBuffer: GPUBuffer | null = null;
  private outRecords: GPUBuffer | null = null;
  private outDeltas: GPUBuffer | null = null;
  private metaBuffer: GPUBuffer | null = null;
  private argsBuffer: GPUBuffer | null = null;
  private readonly paramsBuffers: GPUBuffer[];
  private readonly params = new ArrayBuffer(PARAMS_BYTES);
  private state = new Uint32Array(0);
  private stateDirtyLo = Infinity;
  private stateDirtyHi = -1;
  private readonly templates = new Map<number, PoolTemplate>();
  private readonly groups = new DrawGroups();
  private layoutDirty = true;
  private readonly palette = new ColourPalette();
  private paletteOffsetWords = 0;
  /** One bind group per cull view (they differ only in the uniform); null until `flush` rebuilds them. */
  private bindGroups: GPUBindGroup[] | null = null;
  private readonly pipelineLayout: GPUPipelineLayout;
  private readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly cullPipeline: GPUComputePipeline;
  private readonly resetPipeline: GPUComputePipeline;
  private isolationActive = false;

  constructor(device: GPUDevice) {
    this.device = device;
    this.paramsBuffers = [0, 1, 2].map((v) => device.createBuffer({ label: `gpu-instance-pool-params-${v}`, size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const storage = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    this.bindGroupLayout = device.createBindGroupLayout({
      label: 'gpu-instance-pool-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        storage(1, 'read-only-storage'), storage(2, 'read-only-storage'), storage(3, 'read-only-storage'), storage(4, 'read-only-storage'),
        storage(5, 'storage'), storage(6, 'storage'), storage(7, 'storage'),
      ],
    });
    this.pipelineLayout = device.createPipelineLayout({ label: 'gpu-instance-pool-layout', bindGroupLayouts: [this.bindGroupLayout] });
    device.pushErrorScope('validation');
    const module = device.createShaderModule({ label: 'gpu-instance-cull', code: gpuInstanceCullWgsl });
    this.cullPipeline = device.createComputePipeline({ label: 'gpu-instance-cull', layout: this.pipelineLayout, compute: { module, entryPoint: 'cull' } });
    this.resetPipeline = device.createComputePipeline({ label: 'gpu-instance-reset', layout: this.pipelineLayout, compute: { module, entryPoint: 'resetArgs' } });
    // Reported, not recovered: once the pool owns instanced records there is no per-template copy to fall back to.
    void device.popErrorScope().then((error) => { if (error) console.error('[GpuInstancePool] cull pipeline rejected:', error.message); });
  }

  get occurrenceCount(): number { return this.count; }
  /** Bumped by every template add or removal: occurrence state may be fresh (reused or new ranges). */
  registrations = 0;

  /**
   * Reserve `count` contiguous occurrence ids; returns the first, reusing a
   * removed template's range when one fits, or -1 past the device's buffer
   * limits (those occurrences are not drawn; the error says so).
   */
  allocate(count: number): number {
    const reused = this.freeRanges.take(count);
    if (reused >= 0) { for (let i = reused; i < reused + count; i++) this.setState(i, 0); return reused; }
    if (this.count + count > this.maxOccurrences) {
      console.error(`[GpuInstancePool] ${this.count + count} occurrences exceed this device's buffer limits (${this.maxOccurrences}); the rest are not drawn`);
      return -1;
    }
    const base = this.count;
    this.ensureCapacity(base + count);
    this.count += count;
    return base;
  }

  private readonly freeRanges = new FreeRanges();
  /** Largest occurrence count whose biggest table (88 B records) fits one buffer and storage binding. */
  private get maxOccurrences(): number {
    const l = this.device.limits;
    return l ? Math.floor(Math.min(l.maxBufferSize, l.maxStorageBufferBindingSize) / INSTANCE_STRIDE_BYTES) : Infinity;
  }

  /**
   * Register a template whose `count` occurrences were allocated at `base`:
   * upload its records and cull data, and join (or create) its draw group (returned).
   */
  addTemplate(slot: number, base: number, geometry: PoolGeometry, records: ArrayBuffer, anchors: Float64Array, radii: Float32Array): number {
    const count = radii.length;
    const group = this.groups.join(slot, geometry, count);
    this.templates.set(slot, { base, count, group, radii });
    this.writeSource(base, records, anchors, radii, group, 0, count, true);
    this.layoutDirty = true; this.registrations++;
    return group;
  }

  /**
   * Re-upload records and anchors after a placement moved them: the whole
   * template, or only the occurrences at `indices` (an entity move). A rigid
   * move keeps each sphere's radius about its own anchor.
   */
  refreshTemplate(slot: number, records: ArrayBuffer, anchors: Float64Array, indices?: Iterable<number>): void {
    const t = this.templates.get(slot);
    if (!t) return;
    if (!indices) { this.writeSource(t.base, records, anchors, t.radii, t.group, 0, t.count); return; }
    for (const i of indices) if (i >= 0 && i < t.count) this.writeSource(t.base, records, anchors, t.radii, t.group, i, i + 1);
  }

  /** Mark a removed template's occurrences dead and drop it from its group. */
  removeTemplate(slot: number): void {
    const t = this.templates.get(slot);
    if (!t) return;
    this.templates.delete(slot);
    for (let i = t.base; i < t.base + t.count; i++) this.setState(i, (this.state[i]! & ~POOL_STATE_SELECTED) | POOL_STATE_DEAD);
    this.groups.leave(t.group, slot);
    this.freeRanges.release(t.base, t.count);
    this.registrations++; this.palette.freed = true;
    this.layoutDirty = true;
  }

  /**
   * Upload occurrences `lo..hi` of a template at `base`: records, cull entries
   * and the DEAD bit (set outside the RTE source envelope, cleared once back
   * in it). `takeHidden` carries a record's HIDDEN flag (a tombstone the CPU
   * record holds, e.g. across device recovery) into the state word.
   */
  private writeSource(base: number, records: ArrayBuffer, anchors: Float64Array, radii: Float32Array, group: number, lo: number, hi: number, takeHidden = false): void {
    this.device.queue.writeBuffer(this.srcRecords!, (base + lo) * INSTANCE_STRIDE_BYTES, records, lo * INSTANCE_STRIDE_BYTES, (hi - lo) * INSTANCE_STRIDE_BYTES);
    const cull = new Float32Array((hi - lo) * CULL_FLOATS);
    const cullU = new Uint32Array(cull.buffer);
    const flags = takeHidden ? new DataView(records) : null;
    for (let i = lo; i < hi; i++) {
      const ax = anchors[i * 3]!, ay = anchors[i * 3 + 1]!, az = anchors[i * 3 + 2]!;
      const o = (i - lo) * CULL_FLOATS, at = base + i;
      if (flags && (flags.getUint32(i * INSTANCE_STRIDE_BYTES + INSTANCE_FLAGS_OFFSET, true) & INSTANCE_FLAG_HIDDEN)) this.setState(at, this.state[at]! | POOL_STATE_HIDDEN);
      const ok = Math.abs(ax) <= MAX_RTE_SOURCE_ABS_METRES && Math.abs(ay) <= MAX_RTE_SOURCE_ABS_METRES && Math.abs(az) <= MAX_RTE_SOURCE_ABS_METRES;
      // Outside the f64 source envelope (or non-finite): not drawable, like the CPU packer, until a move brings it back.
      this.setState(at, ok ? this.state[at]! & ~POOL_STATE_DEAD : this.state[at]! | POOL_STATE_DEAD);
      if (!ok) continue;
      // f64 → (high, low) f32 split, inlined (no per-occurrence allocation on multi-million uploads).
      const xh = Math.fround(ax), yh = Math.fround(ay), zh = Math.fround(az);
      const r = radii[i]!;
      cull[o] = xh; cull[o + 1] = yh; cull[o + 2] = zh; cull[o + 3] = Number.isFinite(r) && r >= 0 ? Math.min(r, UNBOUNDED_RADIUS) : UNBOUNDED_RADIUS;
      cull[o + 4] = ax - xh; cull[o + 5] = ay - yh; cull[o + 6] = az - zh; cullU[o + 7] = group;
    }
    this.device.queue.writeBuffer(this.srcCull!, (base + lo) * CULL_BYTES, cull);
  }

  // ── state ────────────────────────────────────────────────────────────

  private setState(i: number, value: number): void {
    value >>>= 0;
    if (this.state[i] === value) return;
    this.state[i] = value >>> 0;
    if (i < this.stateDirtyLo) this.stateDirtyLo = i;
    if (i > this.stateDirtyHi) this.stateDirtyHi = i;
  }

  /**
   * The scene's per-occurrence lane write, redirected: a flags write sets the
   * selected/hidden bits, a colour write sets the palette index (0 = the
   * record's own colour). No GPU call happens here; `flush` uploads.
   */
  writeLane(occurrence: number, lane: number, data: Uint32Array | Float32Array, originalColor: readonly [number, number, number, number]): void {
    if (occurrence < 0 || occurrence >= this.count) return;
    const cur = this.state[occurrence]!;
    if (lane === INSTANCE_FLAGS_OFFSET) {
      const flags = (data as Uint32Array)[0]! & (INSTANCE_FLAG_SELECTED | INSTANCE_FLAG_HIDDEN);
      const next = (cur & ~(POOL_STATE_SELECTED | POOL_STATE_HIDDEN)) | flags;
      this.setState(occurrence, next);
    } else if (lane === INSTANCE_COLOR_OFFSET) {
      const c = data as Float32Array;
      const idx = c[0] === originalColor[0] && c[1] === originalColor[1] && c[2] === originalColor[2] && c[3] === originalColor[3]
        ? 0 : this.paletteIndex(c);
      const old = cur >>> POOL_STATE_PALETTE_SHIFT;
      if (old !== 0 && old !== idx) this.palette.freed = true; // the old entry may have lost its last user
      this.setState(occurrence, (cur & 0xffff) | (idx << POOL_STATE_PALETTE_SHIFT));
    }
  }

  private paletteIndex(c: Float32Array): number {
    return this.palette.resolve(c, this.state.subarray(0, this.count), POOL_STATE_PALETTE_SHIFT, POOL_STATE_DEAD, (i, v) => this.setState(i, v));
  }

  /** Set or clear `bit` (USER_HIDDEN / ISOLATED) on one occurrence. */
  setVisibilityBit(occurrence: number, bit: number, on: boolean): void {
    if (occurrence < 0 || occurrence >= this.count) return;
    const cur = this.state[occurrence]!;
    this.setState(occurrence, on ? cur | bit : cur & ~bit);
  }

  /** Isolation on: only ISOLATED occurrences survive the cull (one uniform bit). */
  setIsolationActive(active: boolean): void {
    this.isolationActive = active;
  }

  // ── buffers ──────────────────────────────────────────────────────────

  private ensureCapacity(needed: number): void {
    if (needed <= this.capacity) return;
    let cap = Math.max(65536, this.capacity);
    while (cap < needed) cap *= 2;
    cap = Math.max(needed, Math.min(cap, this.maxOccurrences));
    const d = this.device;
    const make = (label: string, bytes: number, usage: number) => d.createBuffer({ label, size: Math.max(16, bytes), usage });
    const srcRecords = make('gpu-instance-pool-records', cap * INSTANCE_STRIDE_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const srcCull = make('gpu-instance-pool-cull', cap * CULL_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const stateBuffer = make('gpu-instance-pool-state', cap * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
    if (this.srcRecords && this.srcCull && this.count > 0) {
      const enc = d.createCommandEncoder({ label: 'gpu-instance-pool-grow' });
      enc.copyBufferToBuffer(this.srcRecords, 0, srcRecords, 0, this.count * INSTANCE_STRIDE_BYTES);
      enc.copyBufferToBuffer(this.srcCull, 0, srcCull, 0, this.count * CULL_BYTES);
      d.queue.submit([enc.finish()]);
    }
    this.srcRecords?.destroy(); this.srcCull?.destroy(); this.stateBuffer?.destroy();
    this.outRecords?.destroy(); this.outDeltas?.destroy();
    this.srcRecords = srcRecords; this.srcCull = srcCull; this.stateBuffer = stateBuffer;
    this.outRecords = make('gpu-instance-pool-out-records', cap * INSTANCE_STRIDE_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX);
    this.outDeltas = make('gpu-instance-pool-out-deltas', cap * INSTANCED_RTE_DELTA_STRIDE_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX);
    const state = new Uint32Array(cap);
    state.set(this.state.subarray(0, this.count));
    this.state = state;
    this.stateDirtyLo = 0; this.stateDirtyHi = Math.max(0, this.count - 1);
    this.capacity = cap;
    this.bindGroups = null;
  }

  private rebuildLayout(): void {
    const args = this.groups.layout(ARGS_WORDS);
    if (!this.argsBuffer || this.argsBuffer.size < args.byteLength) {
      this.argsBuffer?.destroy();
      this.argsBuffer = this.device.createBuffer({ label: 'gpu-instance-pool-args', size: Math.max(64, args.byteLength * 2), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
      this.bindGroups = null;
    }
    this.device.queue.writeBuffer(this.argsBuffer, 0, args);
    this.layoutDirty = false;
    this.palette.dirty = true;
  }

  private writeMeta(): void {
    const groupCount = this.groups.length;
    this.paletteOffsetWords = Math.ceil(Math.max(1, groupCount) / 4) * 4;
    const words = new Uint32Array(this.paletteOffsetWords + this.palette.colours.length);
    for (let g = 0; g < groupCount; g++) words[g] = this.groups.at(g)!.base;
    new Float32Array(words.buffer, this.paletteOffsetWords * 4).set(this.palette.colours);
    if (!this.metaBuffer || this.metaBuffer.size < words.byteLength) {
      this.metaBuffer?.destroy();
      this.metaBuffer = this.device.createBuffer({ label: 'gpu-instance-pool-meta', size: Math.max(64, words.byteLength * 2), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.bindGroups = null;
    }
    this.device.queue.writeBuffer(this.metaBuffer, 0, words);
    this.palette.dirty = false;
  }

  /** Upload pending layout, palette and state edits. Call before `cull`. */
  flush(): void {
    if (this.count === 0) return;
    if (this.layoutDirty) this.rebuildLayout();
    if (this.palette.dirty) this.writeMeta();
    if (this.stateDirtyHi >= this.stateDirtyLo) {
      const lo = this.stateDirtyLo, hi = this.stateDirtyHi + 1;
      this.device.queue.writeBuffer(this.stateBuffer!, lo * 4, this.state, lo, hi - lo);
      this.stateDirtyLo = Infinity; this.stateDirtyHi = -1;
    }
    this.bindGroups ??= this.paramsBuffers.map((params) => this.device.createBindGroup({
        label: 'gpu-instance-pool-bg',
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: { buffer: this.srcRecords! } },
          { binding: 2, resource: { buffer: this.srcCull! } },
          { binding: 3, resource: { buffer: this.stateBuffer! } },
          { binding: 4, resource: { buffer: this.metaBuffer! } },
          { binding: 5, resource: { buffer: this.argsBuffer! } },
          { binding: 6, resource: { buffer: this.outRecords! } },
          { binding: 7, resource: { buffer: this.outDeltas! } },
        ],
      }));
  }

  /**
   * Write view `view`'s cull uniform and record reset + cull dispatches into
   * `encoder`. The compacted output is shared: record each cull right before
   * the passes that draw it.
   */
  cull(encoder: GPUCommandEncoder, p: PoolCullParams, timestampWrites?: GPUComputePassTimestampWrites, view: PoolCullView = POOL_VIEW_COLOUR): void {
    if (this.count === 0 || !this.bindGroups) return;
    const { wx, wy } = packCullParams(this.params, p, this.count, this.groups.length, this.isolationActive, this.paletteOffsetWords);
    this.device.queue.writeBuffer(this.paramsBuffers[view]!, 0, this.params);
    const pass = encoder.beginComputePass({ label: 'gpu-instance-cull', ...(timestampWrites ? { timestampWrites } : {}) });
    pass.setBindGroup(0, this.bindGroups[view]!);
    pass.setPipeline(this.resetPipeline);
    pass.dispatchWorkgroups(Math.ceil(Math.max(1, this.groups.length) / WORKGROUP));
    pass.setPipeline(this.cullPipeline);
    pass.dispatchWorkgroups(wx, wy);
    pass.end();
  }

  /**
   * Draw the compacted occurrences: per live group, bind its region at an
   * offset and issue one `drawIndexedIndirect`. Returns the draw count.
   * `only` restricts to those groups (the selection mask).
   */
  draw(pass: GPURenderPassEncoder, only?: readonly number[]): number {
    if (this.count === 0 || !this.argsBuffer || !this.outRecords || !this.outDeltas) return 0;
    let draws = 0;
    const n = only ? only.length : this.groups.length;
    for (let k = 0; k < n; k++) {
      const g = only ? only[k]! : k;
      const group = this.groups.at(g);
      const geo = group?.members[0];
      if (!group || !geo || group.capacity === 0) continue;
      pass.setVertexBuffer(0, geo.vertexBuffer);
      pass.setVertexBuffer(1, this.outRecords, group.base * INSTANCE_STRIDE_BYTES, group.capacity * INSTANCE_STRIDE_BYTES);
      pass.setVertexBuffer(2, this.outDeltas, group.base * INSTANCED_RTE_DELTA_STRIDE_BYTES, group.capacity * INSTANCED_RTE_DELTA_STRIDE_BYTES);
      pass.setIndexBuffer(geo.indexBuffer, 'uint32');
      pass.drawIndexedIndirect(this.argsBuffer, g * ARGS_WORDS * 4);
      draws++;
    }
    return draws;
  }

  /** GPU bytes the pool holds (source records, cull data, state, compacted records and deltas). */
  gpuBytes(): number {
    return this.capacity * (2 * INSTANCE_STRIDE_BYTES + CULL_BYTES + INSTANCED_RTE_DELTA_STRIDE_BYTES + 4);
  }

  destroy(): void {
    for (const b of [this.srcRecords, this.srcCull, this.stateBuffer, this.outRecords, this.outDeltas, this.metaBuffer, this.argsBuffer, ...this.paramsBuffers]) b?.destroy();
    this.srcRecords = this.srcCull = this.stateBuffer = this.outRecords = this.outDeltas = this.metaBuffer = this.argsBuffer = null;
    this.templates.clear();
    this.groups.clear();
    this.count = 0;
    this.capacity = 0;
    this.bindGroups = null;
  }
}
