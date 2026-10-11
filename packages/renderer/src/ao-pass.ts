/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Screen-space ambient occlusion pass (#5384): the GPU side of
 * `shaders/ao.wgsl.ts`. It reads the scene depth attachment after the main
 * pass and multiplies the resolved colour by the occlusion it finds.
 *
 * Passes per frame: AO (half resolution at `low`, full at `high`), a
 * horizontal and a vertical bilateral blur at the same resolution, and a
 * full-resolution composite onto the canvas with the darken blend the other
 * overlays use (`dst * (1 - srcAlpha)`).
 *
 * Owns two `rg16float` targets (occlusion + linear depth, and the blur
 * scratch). They follow the drawing-buffer size and the quality, are
 * rebuilt when either changes, and are released by `destroy()`; the renderer
 * drops the whole pass when AO is switched off and on teardown (device loss
 * re-creates it on the next AO frame).
 */

import { AO_UNIFORM_BYTES, aoTargetSize, packAoUniforms, type AoFrameParams } from './ao-params.js';
import { aoShaderSource } from './shaders/ao.wgsl.js';

const AO_TARGET_FORMAT: GPUTextureFormat = 'rg16float';

export interface AoPassFrame {
  encoder: GPUCommandEncoder;
  /** Resolved colour to darken (the canvas texture). */
  targetView: GPUTextureView;
  /** Depth-only view of the scene depth attachment. */
  depthView: GPUTextureView;
  params: AoFrameParams;
}

interface AoTargets {
  width: number;
  height: number;
  ao: GPUTexture;
  scratch: GPUTexture;
  aoView: GPUTextureView;
  scratchView: GPUTextureView;
}

interface AoBindGroups {
  depthView: GPUTextureView;
  ao: GPUBindGroup;
  blurH: GPUBindGroup;
  blurV: GPUBindGroup;
  composite: GPUBindGroup;
}

export class AoPass {
  private readonly device: GPUDevice;
  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformScratch = new Float32Array(AO_UNIFORM_BYTES / 4);
  private readonly aoLayout: GPUBindGroupLayout;
  private readonly filterLayout: GPUBindGroupLayout;
  private readonly aoPipeline: GPURenderPipeline;
  private readonly blurHPipeline: GPURenderPipeline;
  private readonly blurVPipeline: GPURenderPipeline;
  private readonly compositePipeline: GPURenderPipeline;
  private targets: AoTargets | null = null;
  private bindGroups: AoBindGroups | null = null;
  private destroyed = false;

  constructor(device: GPUDevice, colorFormat: GPUTextureFormat, sampleCount: number) {
    this.device = device;
    this.uniformBuffer = device.createBuffer({
      label: 'ao-uniforms',
      size: AO_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const depthEntry: GPUBindGroupLayoutEntry = {
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: 'depth', viewDimension: '2d', multisampled: sampleCount > 1 },
    };
    const paramsEntry: GPUBindGroupLayoutEntry = {
      binding: 1,
      visibility: GPUShaderStage.FRAGMENT,
      buffer: { type: 'uniform' },
    };
    this.aoLayout = device.createBindGroupLayout({ label: 'ao-bgl', entries: [depthEntry, paramsEntry] });
    this.filterLayout = device.createBindGroupLayout({
      label: 'ao-filter-bgl',
      entries: [
        depthEntry,
        paramsEntry,
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    });

    const module = device.createShaderModule({ label: 'ao-shader', code: aoShaderSource(sampleCount > 1) });
    const make = (label: string, layout: GPUBindGroupLayout, entryPoint: string, target: GPUColorTargetState) =>
      device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module, entryPoint: 'vs_fullscreen' },
        fragment: { module, entryPoint, targets: [target] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
      });
    this.aoPipeline = make('ao-pipeline', this.aoLayout, 'fs_ao', { format: AO_TARGET_FORMAT });
    this.blurHPipeline = make('ao-blur-h-pipeline', this.filterLayout, 'fs_blur_h', { format: AO_TARGET_FORMAT });
    this.blurVPipeline = make('ao-blur-v-pipeline', this.filterLayout, 'fs_blur_v', { format: AO_TARGET_FORMAT });
    this.compositePipeline = make('ao-composite-pipeline', this.filterLayout, 'fs_composite', {
      format: colorFormat,
      // Darken overlay: dst' = dst * (1 - srcAlpha); canvas alpha untouched.
      blend: {
        color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha' },
        alpha: { srcFactor: 'zero', dstFactor: 'one' },
      },
    });
  }

  encode(frame: AoPassFrame): void {
    if (this.destroyed) return;
    const { width, height } = aoTargetSize(frame.params.width, frame.params.height, frame.params.quality);
    const targets = this.ensureTargets(width, height);
    const groups = this.ensureBindGroups(targets, frame.depthView);

    packAoUniforms(this.uniformScratch, frame.params);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformScratch);

    const run = (label: string, view: GPUTextureView, pipeline: GPURenderPipeline, group: GPUBindGroup, load: GPULoadOp) => {
      const pass = frame.encoder.beginRenderPass({
        label,
        colorAttachments: [{ view, loadOp: load, storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3, 1, 0, 0);
      pass.end();
    };
    run('ao', targets.aoView, this.aoPipeline, groups.ao, 'clear');
    run('ao-blur-h', targets.scratchView, this.blurHPipeline, groups.blurH, 'clear');
    run('ao-blur-v', targets.aoView, this.blurVPipeline, groups.blurV, 'clear');
    run('ao-composite', frame.targetView, this.compositePipeline, groups.composite, 'load');
  }

  private ensureTargets(width: number, height: number): AoTargets {
    const current = this.targets;
    if (current && current.width === width && current.height === height) return current;
    this.releaseTargets();
    const make = (label: string) => this.device.createTexture({
      label,
      size: { width, height },
      format: AO_TARGET_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const ao = make('ao-target');
    const scratch = make('ao-scratch');
    this.targets = { width, height, ao, scratch, aoView: ao.createView(), scratchView: scratch.createView() };
    return this.targets;
  }

  private ensureBindGroups(targets: AoTargets, depthView: GPUTextureView): AoBindGroups {
    const current = this.bindGroups;
    if (current && current.depthView === depthView) return current;
    const params = { binding: 1, resource: { buffer: this.uniformBuffer } };
    const depth = { binding: 0, resource: depthView };
    const filter = (label: string, input: GPUTextureView) => this.device.createBindGroup({
      label,
      layout: this.filterLayout,
      entries: [depth, params, { binding: 2, resource: input }],
    });
    this.bindGroups = {
      depthView,
      ao: this.device.createBindGroup({ label: 'ao-bg', layout: this.aoLayout, entries: [depth, params] }),
      blurH: filter('ao-blur-h-bg', targets.aoView),
      blurV: filter('ao-blur-v-bg', targets.scratchView),
      composite: filter('ao-composite-bg', targets.aoView),
    };
    return this.bindGroups;
  }

  private releaseTargets(): void {
    this.targets?.ao.destroy();
    this.targets?.scratch.destroy();
    this.targets = null;
    // Bind groups reference the old views.
    this.bindGroups = null;
  }

  /** Release every GPU resource. Idempotent; the pass is unusable afterwards. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.releaseTargets();
    this.uniformBuffer.destroy();
  }
}
