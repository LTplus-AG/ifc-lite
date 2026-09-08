/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The focused clash's INTERSECTION SOLID — the true overlap volume of a
 * clashing pair, rendered opaque so it reads as a distinct shape rather than
 * an abstract wireframe box (the BIMcollab Zoom / Solibri presentation the
 * viewer's own overlap-box overlay was compared against and found "not
 * helpful, hard to see").
 *
 * Deliberately its own tiny pipeline rather than a reuse of
 * `SymbolicFillPipeline`: the vertex layout and shader (`SYMBOLIC_FILL_WGSL`,
 * pos.xyz + color.rgba, straight `viewProj * pos`) are identical and shared,
 * but the depth/blend state cannot be — the fill pipeline is a coplanar DECAL
 * (`depthWriteEnabled: false`, negative bias, alpha-blended) for flat
 * annotation regions that sit ON a real surface. The intersection solid is a
 * real enclosed 3D volume: it must depth-test AND depth-write like ordinary
 * opaque geometry so its own front/back triangles resolve correctly and it is
 * properly occluded by unrelated opaque geometry in front of it, while still
 * drawing on top of (and being visible through) the two ghosted parent
 * elements — ghosted geometry renders with `depthWriteEnabled: false`
 * (`pipeline.ts`), so it never occludes anything drawn after it in the same
 * pass, including this.
 */

import { SYMBOLIC_FILL_WGSL } from './shaders/symbolic-overlay.wgsl.js';
import { PIPELINE_CONSTANTS } from './constants.js';

const VERTEX_STRIDE_BYTES = (3 + 4) * 4; // pos.xyz + color.rgba, 4 bytes each

/** One flat opaque colour for the whole solid — BIMcollab-style, not per-triangle. */
export interface ClashSolidInput {
  /** World-space vertex positions, flat `[x, y, z, …]`. */
  positions: Float32Array | Float64Array;
  /** Triangle indices into `positions / 3`. */
  indices: Uint32Array;
  /** Straight-alpha RGBA in [0..1]. Alpha 1 renders fully opaque. */
  color: [number, number, number, number];
}

/**
 * Expand an indexed triangle mesh + single colour into the flat
 * pos+color-per-vertex stream `SYMBOLIC_FILL_WGSL` expects, matching
 * `triangulateFillTo`'s non-indexed triangle-list convention.
 */
export function expandTriangles(input: ClashSolidInput): Float32Array {
  const { positions, indices, color } = input;
  const triCount = Math.floor(indices.length / 3);
  const out = new Float32Array(triCount * 3 * 7);
  let w = 0;
  for (let t = 0; t < triCount; t += 1) {
    for (let k = 0; k < 3; k += 1) {
      const vi = indices[t * 3 + k] * 3;
      out[w++] = positions[vi];
      out[w++] = positions[vi + 1];
      out[w++] = positions[vi + 2];
      out[w++] = color[0];
      out[w++] = color[1];
      out[w++] = color[2];
      out[w++] = color[3];
    }
  }
  return out;
}

export class ClashSolidPipeline {
  private readonly device: GPUDevice;
  private readonly format: GPUTextureFormat;
  private readonly sampleCount: number;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private vertexCount = 0;

  constructor(device: GPUDevice, presentationFormat: GPUTextureFormat, sampleCount: number = 1) {
    this.device = device;
    this.format = presentationFormat;
    this.sampleCount = sampleCount;
  }

  private init(): void {
    if (this.pipeline) return;

    this.bindGroupLayout = this.device.createBindGroupLayout({
      label: 'clash-solid-bgl',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    });

    const module = this.device.createShaderModule({
      label: 'clash-solid-shader',
      code: SYMBOLIC_FILL_WGSL,
    });

    this.pipeline = this.device.createRenderPipeline({
      label: 'clash-solid-pipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: {
        module,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: VERTEX_STRIDE_BYTES,
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 3 * 4, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: 'fs_main',
        // Same two-target layout as every other overlay pipeline sharing this
        // pass: presentation colour + the picker objectId, write-masked off so
        // the opaque pass's picker IDs underneath survive.
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
            writeMask: GPUColorWrite.ALL,
          },
          { format: 'rgba8unorm', writeMask: 0 },
        ],
      },
      // `cullMode: 'none'`: the intersection kernel's output winding isn't a
      // contract the renderer depends on (mirrors the main opaque pipeline's
      // own "IFC winding order varies" choice), and a double-sided draw still
      // looks correct for a convex-ish overlap volume viewed from outside.
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: PIPELINE_CONSTANTS.DEPTH_FORMAT,
        // Unlike the fill pipeline's decal, this is a real volume: it must
        // write depth so its own triangles sort against each other and so it
        // is correctly occluded by opaque geometry drawn earlier in the pass.
        depthWriteEnabled: true,
        depthCompare: 'greater', // Reverse-Z, matches the main opaque pipeline.
        // Small decal bias so a face that lands exactly on a parent's own
        // surface (a flush overlap boundary) doesn't z-fight with it.
        depthBias: -2,
        depthBiasSlopeScale: -0.25,
        depthBiasClamp: 0,
      },
      multisample: { count: this.sampleCount },
    });

    this.uniformBuffer = this.device.createBuffer({
      label: 'clash-solid-camera',
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroup = this.device.createBindGroup({
      label: 'clash-solid-bg',
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  /** Upload the solid mesh. Pass `null` to clear. */
  upload(input: ClashSolidInput | null): void {
    this.init();

    if (this.vertexBuffer) {
      this.vertexBuffer.destroy();
      this.vertexBuffer = null;
    }
    this.vertexCount = 0;

    if (!input || input.indices.length === 0) return;

    const data = expandTriangles(input);
    if (data.length === 0) return;

    this.vertexBuffer = this.device.createBuffer({
      label: 'clash-solid-vbuf',
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, data);
    this.vertexCount = data.length / (VERTEX_STRIDE_BYTES / 4);
  }

  hasGeometry(): boolean {
    return this.vertexCount > 0;
  }

  render(pass: GPURenderPassEncoder, viewProj: Float32Array): void {
    if (!this.pipeline || !this.uniformBuffer || !this.bindGroup || !this.vertexBuffer) return;
    if (this.vertexCount === 0) return;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, viewProj);
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(this.vertexCount);
  }

  destroy(): void {
    if (this.vertexBuffer) this.vertexBuffer.destroy();
    if (this.uniformBuffer) this.uniformBuffer.destroy();
    this.vertexBuffer = null;
    this.uniformBuffer = null;
    this.bindGroup = null;
    this.bindGroupLayout = null;
    this.pipeline = null;
    this.vertexCount = 0;
  }
}
