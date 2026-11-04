/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The WebGPU pipeline for filled IfcAnnotation regions (issue #653), split from
 * `symbolic-overlay-pipelines.ts` (which re-exports it) when the fills gained
 * their section clip (#8767). It owns its buffers, bind groups and pipeline
 * state, and draws from inside the caller's RGBA-blended render pass.
 */

import { uploadFillPartition } from './symbolic-fill-upload.js';
import { SYMBOLIC_FILL_CLIPPED_WGSL, SYMBOLIC_FILL_UNIFORM_FLOATS } from './shaders/symbolic-overlay.wgsl.js';
import { MAX_CAP_CLIP_PLANES, packExtraClip } from './extra-clip-planes.js';
import type { ExtraClipPlane } from './clip-types.js';
import { PIPELINE_CONSTANTS } from './constants.js';
import { tryPackRteDrawableDelta } from './relative-to-eye.js';
import { triangulateFillTo } from './symbolic-overlay-geometry.js';

const FILL_VERTEX_STRIDE_BYTES = (3 + 4) * 4; // pos.xyz + color.rgba, 4 bytes each

// ─── Fill input ─────────────────────────────────────────────────────────────

export interface SymbolicFillInput {
  /** Flat ring buffer: [x, z, x, z, …]. Y is taken from `worldY`. */
  points: Float32Array;
  /** Vertex indices marking the start of each hole. Empty = no holes. */
  holesOffsets: Uint32Array;
  worldY: number;
  /** Opt-in f64 anchor. points/worldY are local to it; legacy inputs omit it. */
  origin?: [number, number, number];
  /** Straight-alpha RGBA in [0..1]. The shader premultiplies. */
  color: [number, number, number, number];
  /** Does this fill DEFINE the model's extent? Default true; see `uploadFills` (#3359). */
  definesExtent?: boolean;  /**
   * Clip this fill like the model: what the section plane, an extra cutting plane or the clip box
   * removes is discarded (#8767). Default false, which draws it everywhere as before. IfcAnnotation
   * regions set it; grid bubbles, a reference layer with its own section band, do not.
   */
  sectionClipped?: boolean;
}

// ─── Fill pipeline ──────────────────────────────────────────────────────────

export class SymbolicFillPipeline {
  private readonly device: GPUDevice;
  private readonly format: GPUTextureFormat;
  private readonly sampleCount: number;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  /**
   * Each partition owns its uniform resource. Queue writes happen before the
   * encoded pass executes, so using one buffer for several partitions makes
   * every draw observe the final anchor written that frame.
   */
  private partitions: Array<{
    vertexBuffer: GPUBuffer; vertexCount: number; origin?: [number, number, number];
    uniformBuffer: GPUBuffer; bindGroup: GPUBindGroup;
    /** Clipped like the model (#8767); a partition never mixes clipped and unclipped fills. */
    sectionClipped: boolean;
  }> = [];

  constructor(device: GPUDevice, presentationFormat: GPUTextureFormat, sampleCount: number = 1) {
    this.device = device;
    this.format = presentationFormat;
    this.sampleCount = sampleCount;
  }

  private init(): void {
    if (this.pipeline) return;

    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'symbolic-fill-bgl',
      entries: [
        {
          binding: 0,
          // The fragment stage reads the clip block (#8767).
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const module = this.device.createShaderModule({
      label: 'symbolic-fill-shader',
      code: SYMBOLIC_FILL_CLIPPED_WGSL,
    });

    this.pipeline = this.device.createRenderPipeline({
      label: 'symbolic-fill-pipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: FILL_VERTEX_STRIDE_BYTES,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },        // position
              { shaderLocation: 1, offset: 3 * 4, format: 'float32x4' },    // color
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        // The main render pass attaches 2 colour targets (presentation + the
        // picker objectId) and runs MSAA. Pipelines used inside that pass
        // must declare matching targets and sampleCount or WebGPU rejects
        // them at validation time. The objectId slot is write-masked off so
        // the picker IDs from the opaque pass underneath are preserved.
        targets: [
          {
            format: this.format,
            blend: {
              // Standard "one * src + (1 - src.a) * dst" composite — the
              // shader writes premultiplied alpha.
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
            writeMask: GPUColorWrite.ALL,
          },
          { format: 'rgba8unorm', writeMask: 0 },
        ],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: PIPELINE_CONSTANTS.DEPTH_FORMAT,
        depthWriteEnabled: false,
        // Reverse-Z: the renderer clears depth to 0.0 and uses 'greater' /
        // 'greater-equal' for everything in the main pass. 'less-equal'
        // would fail the test on every visible surface.
        depthCompare: 'greater-equal',
        // Decal bias: nudge fills slightly closer to camera so they don't
        // z-fight when coplanar with a wall/floor face (issue #812).
        // Reverse-Z → larger depth is closer → negative bias.
        depthBias: -4,
        depthBiasSlopeScale: -0.5,
        depthBiasClamp: 0,
      },
      multisample: { count: this.sampleCount },
    });

  }

  /**
   * Upload a list of fill regions. Each region is triangulated by the shared
   * even-odd triangulator (`fill-triangulate.ts`) into a single vertex buffer.
   *
   * Pass an empty array to clear. Rings with fewer than 3 vertices are
   * dropped, and so is any ring set that yields no triangle at all (a fully
   * collinear bound). Inner bounds themselves are never dropped: since #2516
   * the bridge always finds an anchor, so a hole cannot fall out of the
   * result the way it used to when it "couldn't be merged".
   */
  upload(fills: readonly SymbolicFillInput[]): void {
    this.init();

    // Drop the previous buffer eagerly so swapping models doesn't accumulate.
    for (const partition of this.partitions) {
      partition.vertexBuffer.destroy();
      partition.uniformBuffer.destroy();
    }
    this.partitions = [];

    if (fills.length === 0) return;

    // Legacy (unanchored) fills share a partition per clip mode.
    const legacy: number[] = [];
    const legacyClipped: number[] = [];
    for (const fill of fills) {
      const stream: number[] = [];
      triangulateFillTo(stream, fill);
      const clipped = fill.sectionClipped === true;
      if (fill.origin) this.addPartition(stream, clipped, fill.origin);
      else (clipped ? legacyClipped : legacy).push(...stream);
    }
    this.addPartition(legacy, false);
    this.addPartition(legacyClipped, true);
  }

  hasGeometry(): boolean {
    return this.partitions.length > 0;
  }

  private addPartition(stream: number[], sectionClipped: boolean, origin?: [number, number, number]): void {
    if (stream.length === 0 || !this.bindGroupLayout) return;
    const data = new Float32Array(stream);
    uploadFillPartition(this.device, this.bindGroupLayout, data, SYMBOLIC_FILL_UNIFORM_FLOATS * 4, (vertexBuffer, uniformBuffer, bindGroup) => {
      this.partitions.push({ vertexBuffer, uniformBuffer, bindGroup,
        vertexCount: data.length / (FILL_VERTEX_STRIDE_BYTES / 4), origin, sectionClipped });
    });
  }

  /** `clippedBy`: the frame's model clip as planes (`clipStatePlanes`), applied to the clipped partitions (#8767). */
  render(
    pass: GPURenderPassEncoder, viewProj: Float32Array, rteViewProj?: Float32Array, camera?: readonly [number, number, number],
    clippedBy: readonly ExtraClipPlane[] = [],
  ): void {
    if (!this.pipeline) return;
    pass.setPipeline(this.pipeline);
    for (const partition of this.partitions) {
      const uniform = new Float32Array(SYMBOLIC_FILL_UNIFORM_FLOATS); uniform.set(viewProj);
      const rte = !!(partition.origin && rteViewProj && camera);
      if (rte) {
        uniform.set(rteViewProj!, 16);
        // Outside this camera's RTE envelope: not rasterisable this frame (#6128).
        if (!tryPackRteDrawableDelta(partition.origin!, camera!, uniform, 32)) continue;
        uniform[35] = 1;
      }
      // The planes in the frame the shader compares against: eye-relative for RTE, world otherwise.
      // An unclipped partition keeps the zero count the fresh array starts with.
      if (partition.sectionClipped) packExtraClip(clippedBy, rte ? camera! : null, uniform, 40, MAX_CAP_CLIP_PLANES);
      this.device.queue.writeBuffer(partition.uniformBuffer, 0, uniform);
      pass.setBindGroup(0, partition.bindGroup);
      pass.setVertexBuffer(0, partition.vertexBuffer); pass.draw(partition.vertexCount);
    }
  }

  destroy(): void {
    for (const partition of this.partitions) {
      partition.vertexBuffer.destroy();
      partition.uniformBuffer.destroy();
    }
    this.partitions = [];
    this.bindGroupLayout = null;
    this.pipeline = null;
  }
}
