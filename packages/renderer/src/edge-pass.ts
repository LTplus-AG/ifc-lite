/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Edge pass (#5385): the GPU side of `shaders/edges.wgsl.ts`. One fullscreen
 * pass reads the scene depth and object-id attachments after the main pass
 * and darkens the resolved colour along entity boundaries, normal creases
 * and depth silhouettes, in the same darken-blend style as ambient
 * occlusion and the eye-dome-lighting pass (`dst * (1 - srcAlpha)`).
 *
 * Replaces `post-processor.ts`'s separation-line pass (#5384 superseded its
 * ambient-occlusion half already; this PR removes the rest). No offscreen
 * targets: unlike AO it needs no resolution split or blur, so it draws
 * straight onto the resolved canvas.
 */

import { EDGE_UNIFORM_BYTES, type EdgeFrameParams, packEdgeUniforms } from './edge-params.js';
import { edgeShaderSource } from './shaders/edges.wgsl.js';

export interface EdgePassFrame {
  encoder: GPUCommandEncoder;
  /** Resolved colour to darken (the canvas texture). */
  targetView: GPUTextureView;
  /** Depth-only view of the scene depth attachment. */
  depthView: GPUTextureView;
  objectIdView: GPUTextureView;
  params: EdgeFrameParams;
}

export class EdgePass {
  private readonly device: GPUDevice;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformScratch = new Float32Array(EDGE_UNIFORM_BYTES / 4);
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPURenderPipeline;
  private cachedDepthView: GPUTextureView | null = null;
  private cachedObjectIdView: GPUTextureView | null = null;
  private cachedBindGroup: GPUBindGroup | null = null;
  private destroyed = false;

  constructor(device: GPUDevice, colorFormat: GPUTextureFormat, sampleCount: number) {
    this.device = device;
    const multisampled = sampleCount > 1;
    this.uniformBuffer = device.createBuffer({
      label: 'edge-uniforms',
      size: EDGE_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.layout = device.createBindGroupLayout({
      label: 'edge-bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth', viewDimension: '2d', multisampled },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d', multisampled },
        },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    });

    const module = device.createShaderModule({ label: 'edge-shader', code: edgeShaderSource(multisampled) });
    this.pipeline = device.createRenderPipeline({
      label: 'edge-pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      vertex: { module, entryPoint: 'vs_fullscreen' },
      fragment: {
        module,
        entryPoint: 'fs_edges',
        targets: [{
          format: colorFormat,
          blend: {
            color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'zero', dstFactor: 'one' },
          },
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
  }

  encode(frame: EdgePassFrame): void {
    if (this.destroyed) return;
    packEdgeUniforms(this.uniformScratch, frame.params);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformScratch);

    if (
      this.cachedDepthView !== frame.depthView ||
      this.cachedObjectIdView !== frame.objectIdView ||
      this.cachedBindGroup === null
    ) {
      this.cachedBindGroup = this.device.createBindGroup({
        label: 'edge-bg',
        layout: this.layout,
        entries: [
          { binding: 0, resource: frame.depthView },
          { binding: 1, resource: frame.objectIdView },
          { binding: 2, resource: { buffer: this.uniformBuffer } },
        ],
      });
      this.cachedDepthView = frame.depthView;
      this.cachedObjectIdView = frame.objectIdView;
    }

    const pass = frame.encoder.beginRenderPass({
      label: 'edges',
      colorAttachments: [{ view: frame.targetView, loadOp: 'load', storeOp: 'store' }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.cachedBindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  /** Release all GPU resources. Idempotent; the pass is unusable afterwards. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.uniformBuffer.destroy();
    this.cachedBindGroup = null;
    this.cachedDepthView = null;
    this.cachedObjectIdView = null;
  }
}
