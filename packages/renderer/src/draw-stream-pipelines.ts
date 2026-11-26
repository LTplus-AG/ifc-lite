/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bind group layout, pipeline layout and the lazily built render pipelines of the draw stream. */
import type { RenderPipeline } from './pipeline.js';
import type { OpaqueDrawMode } from './opaque-draw-variants.js';
import { MESH_VERTEX_BUFFERS, QUANTIZED_VERTEX_BUFFERS } from './instanced-vertex-layout.js';
import { withSectionExclusions } from './section-exclusions.js';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { opaqueFastShaderSource } from './shaders/main-opaque-fast.wgsl.js';
import { streamShaderSource } from './shaders/main-stream.wgsl.js';

/** Indexed by quantized * 4 + discardFree * 2 + objectId. */
const slotOf = (quantized: boolean, mode: OpaqueDrawMode): number => (quantized ? 4 : 0) + (mode.discardFree ? 2 : 0) + (mode.objectId ? 1 : 0);

export class StreamPipelines {
  /** group(0): frame uniform, per-member records, per-member origin deltas. */
  readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly layout: GPUPipelineLayout;
  /** Indexed by `slotOf`. */
  private pipelines: (GPURenderPipeline | undefined)[] = [];
  /** Slots whose async build (`ready`) is running or failed; replaced by `clear`. */
  private building = new Map<number, 'building' | 'failed'>();
  private modules: { full: GPUShaderModule; fast: GPUShaderModule; fullSource: string; fastSource: string } | null = null;

  /** `built` runs when an async build lands, so a resting viewer renders the frame whose prewarm uses it. */
  constructor(private readonly device: GPUDevice, private readonly pipeline: RenderPipeline, private readonly built: () => void = () => {}) {
    const visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.bindGroupLayout = device.createBindGroupLayout({ label: 'draw-stream-bgl', entries: [
      { binding: 0, visibility, buffer: { type: 'uniform' } },
      { binding: 1, visibility, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility, buffer: { type: 'read-only-storage' } },
    ] });
    this.layout = device.createPipelineLayout({ label: 'draw-stream-layout',
      bindGroupLayouts: withSectionExclusions(device, [this.bindGroupLayout, pipeline.getStreamBase().environmentLayout]) });
  }

  /** The stream pipeline for a vertex layout and opaque draw mode, built on first use (synchronously: a live draw needs it now). */
  get(quantized: boolean, mode: OpaqueDrawMode): GPURenderPipeline {
    const slot = slotOf(quantized, mode);
    let p = this.pipelines[slot];
    if (p) return p;
    const { descriptor, source } = this.describe(slot, quantized, mode);
    p = this.pipeline.visibility.create(descriptor, source);
    this.pipelines[slot] = p;
    return p;
  }

  /**
   * Whether both layouts' pipelines for `mode` are built (true), still building (false; starts the async build of any
   * not yet requested) or one failed to build (null: prewarm leaves the mode to the live draw, which builds it in `get`).
   * Prewarm records bundles for a mode no frame draws yet, and a synchronous build there blocks the GPU process on
   * the shader compile (#11481 follow-up; Holter orbit on the PC: two pipelines, 113 ms of DXC, a 120 ms frame).
   */
  ready(mode: OpaqueDrawMode): boolean | null {
    let pending = false, failed = false;
    for (let q = 0; q < 2; q++) {
      const quantized = q === 1, slot = slotOf(quantized, mode);
      if (this.pipelines[slot]) continue;
      const state = this.building.get(slot);
      if (state === 'failed') { failed = true; continue; }
      pending = true;
      if (state) continue;
      const building = this.building; building.set(slot, 'building');
      const { descriptor, source } = this.describe(slot, quantized, mode);
      this.pipeline.visibility.createAsync(descriptor, source).then(
        (p) => { if (building === this.building) { this.pipelines[slot] ??= p; this.built(); } }, // a build from before `clear` is dropped
        (err) => { if (building !== this.building) return; building.set(slot, 'failed'); console.warn(`[DrawStream] ${descriptor.label} failed to build asynchronously:`, err); });
    }
    return pending ? false : failed ? null : true;
  }

  private describe(slot: number, quantized: boolean, mode: OpaqueDrawMode): { descriptor: GPURenderPipelineDescriptor; source: string } {
    if (!this.modules) {
      const fullSource = streamShaderSource(mainShaderSource); const fastSource = streamShaderSource(opaqueFastShaderSource);
      this.modules = { fullSource, fastSource,
        full: this.device.createShaderModule({ label: 'draw-stream', code: fullSource }),
        fast: this.device.createShaderModule({ label: 'draw-stream-fast', code: fastSource }) };
    }
    const base = this.pipeline.getStreamBase().descriptor;
    const frag = base.fragment!;
    const module = mode.discardFree ? this.modules.fast : this.modules.full;
    const targets = [...frag.targets].map((t, i) => (i === 1 && t && !mode.objectId ? { ...t, writeMask: 0 } : t));
    const descriptor: GPURenderPipelineDescriptor = { ...base, label: `draw-stream-${slot}`, layout: this.layout,
      vertex: { module, entryPoint: quantized ? 'vs_stream_quantized' : 'vs_stream', buffers: quantized ? QUANTIZED_VERTEX_BUFFERS : MESH_VERTEX_BUFFERS },
      fragment: { ...frag, module, targets } };
    return { descriptor, source: mode.discardFree ? this.modules.fastSource : this.modules.fullSource };
  }

  clear(): void { this.pipelines = []; this.building = new Map(); }
}
