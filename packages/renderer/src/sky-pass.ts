/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Procedural sky background pass.
 *
 * Draws one fullscreen triangle into the main render pass BEFORE any
 * geometry (the pass's colour attachments are cleared either way, so the
 * sky simply replaces the flat clear colour). Reverse-Z places it at the
 * far plane (z = 0) with depth writes off, so geometry always wins the
 * depth test and transparent surfaces blend over the sky correctly.
 *
 * The pipeline targets must mirror the main pass exactly: colour + object-id
 * attachments and the MSAA sample count. The object-id output is the
 * attachment's clear value, so picking still reads "background" on sky.
 */

import type { ResolvedEnvironment } from './environment.js';

export interface SkyPassFormats {
  colorFormat: GPUTextureFormat;
  objectIdFormat: GPUTextureFormat;
  depthFormat: GPUTextureFormat;
  sampleCount: number;
}

export interface SkyCamera {
  /** Camera world position → target direction, unit. */
  forward: [number, number, number];
  /** Screen-right in world space, unit. */
  right: [number, number, number];
  /** Screen-up in world space, unit. */
  up: [number, number, number];
  /** Vertical field of view in radians. */
  fovY: number;
  /** Viewport width / height. */
  aspect: number;
}

const SKY_UNIFORM_FLOATS = 28; // 7 × vec4 rows = 112 bytes

export class SkyPass {
  private device: GPUDevice;
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private scratch = new Float32Array(SKY_UNIFORM_FLOATS);
  private destroyed = false;

  constructor(device: GPUDevice, formats: SkyPassFormats, shaderSource: string) {
    this.device = device;

    this.uniformBuffer = device.createBuffer({
      label: 'sky-uniforms',
      size: SKY_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = device.createBindGroupLayout({
      label: 'sky-bgl',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });
    this.bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    const module = device.createShaderModule({ label: 'sky-shader', code: shaderSource });
    this.pipeline = device.createRenderPipeline({
      label: 'sky-pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: { module, entryPoint: 'vs_main' },
      fragment: {
        module,
        entryPoint: 'fs_main',
        targets: [{ format: formats.colorFormat }, { format: formats.objectIdFormat }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: formats.depthFormat,
        depthWriteEnabled: false,
        // Drawn first into a depth buffer cleared to 0.0 (reverse-Z far),
        // so z = 0 passes everywhere; kept as a real compare (not 'always')
        // in case the draw ever moves after opaque geometry.
        depthCompare: 'greater-equal',
      },
      multisample: { count: formats.sampleCount },
    });
  }

  /**
   * Record the sky draw into an already-begun render pass. Callers must
   * re-set their own pipeline + group(0) afterwards (the main loop does
   * this per batch anyway).
   */
  draw(pass: GPURenderPassEncoder, camera: SkyCamera, env: ResolvedEnvironment): void {
    if (this.destroyed) return;
    const tanHalfFovY = Math.tan(camera.fovY / 2);
    const tanHalfFovX = tanHalfFovY * camera.aspect;

    const u = this.scratch;
    u[0] = camera.right[0]; u[1] = camera.right[1]; u[2] = camera.right[2];
    u[3] = tanHalfFovX;
    u[4] = camera.up[0]; u[5] = camera.up[1]; u[6] = camera.up[2];
    u[7] = tanHalfFovY;
    u[8] = camera.forward[0]; u[9] = camera.forward[1]; u[10] = camera.forward[2];
    u[11] = env.exposure;
    u[12] = env.sunDirection[0]; u[13] = env.sunDirection[1]; u[14] = env.sunDirection[2];
    u[15] = env.sunIntensity;
    u[16] = env.sky.zenith[0]; u[17] = env.sky.zenith[1]; u[18] = env.sky.zenith[2];
    u[19] = 0;
    u[20] = env.sky.horizon[0]; u[21] = env.sky.horizon[1]; u[22] = env.sky.horizon[2];
    u[23] = 0;
    u[24] = env.sky.ground[0]; u[25] = env.sky.ground[1]; u[26] = env.sky.ground[2];
    u[27] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);

    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.uniformBuffer.destroy();
  }
}
