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

export class StreamPipelines {
  /** group(0): frame uniform, per-member records, per-member origin deltas. */
  readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly layout: GPUPipelineLayout;
  /** Indexed by quantized * 4 + discardFree * 2 + objectId. */
  private pipelines: (GPURenderPipeline | undefined)[] = [];
  private modules: { full: GPUShaderModule; fast: GPUShaderModule; fullSource: string; fastSource: string } | null = null;

  constructor(private readonly device: GPUDevice, private readonly pipeline: RenderPipeline) {
    const visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.bindGroupLayout = device.createBindGroupLayout({ label: 'draw-stream-bgl', entries: [
      { binding: 0, visibility, buffer: { type: 'uniform' } },
      { binding: 1, visibility, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility, buffer: { type: 'read-only-storage' } },
    ] });
    this.layout = device.createPipelineLayout({ label: 'draw-stream-layout',
      bindGroupLayouts: withSectionExclusions(device, [this.bindGroupLayout, pipeline.getStreamBase().environmentLayout]) });
  }

  /** The stream pipeline for a vertex layout and opaque draw mode, built on first use. */
  get(quantized: boolean, mode: OpaqueDrawMode): GPURenderPipeline {
    const slot = (quantized ? 4 : 0) + (mode.discardFree ? 2 : 0) + (mode.objectId ? 1 : 0);
    let p = this.pipelines[slot];
    if (p) return p;
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
    p = this.pipeline.visibility.create(descriptor, mode.discardFree ? this.modules.fastSource : this.modules.fullSource);
    this.pipelines[slot] = p;
    return p;
  }

  clear(): void { this.pipelines = []; }
}
