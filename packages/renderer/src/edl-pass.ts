/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Eye-Dome Lighting (EDL) post-pass.
 *
 * Standard Potree-style screen-space depth shading: for each pixel, sample
 * a few neighbouring depths at radius R, compute the mean log-depth-diff,
 * and darken proportionally. The result is a soft black halo at silhouettes
 * and gives un-normaled point clouds (and triangle meshes) a strong sense
 * of depth without needing geometric normals.
 *
 * Costs ~9 texture taps per pixel (1 centre + 8 neighbours) at the high
 * quality setting, ~5 at low. Cheap on any modern GPU.
 *
 * Render order: this should run AFTER the existing PostProcessor (which
 * does contact / separation shading) so EDL also darkens those overlays.
 *
 * Reverse-Z note: the main pipeline uses depthCompare 'greater' with
 * clearValue 0.0. So depth=1 → near plane, depth=0 → far plane. A bigger
 * neighbour depth means the neighbour is closer; a smaller neighbour depth
 * means it's further. We darken pixels whose neighbours are further away —
 * i.e. silhouette edges — by clamping `max(0, log(centre) - log(neighbour))`.
 */

import { WebGPUDevice } from './device.js';

export interface EdlPassOptions {
  /** Multiplier on the final darken alpha. 0..3, default 1. */
  strength?: number;
  /** Sample radius in pixels. 1..4, default 1. */
  radiusPx?: number;
  /** When true, sample 8 neighbours; when false, just 4 cardinal. */
  highQuality?: boolean;
}

export interface EdlPassApplyOptions {
  /** Output target — typically the swap chain texture view. */
  targetView: GPUTextureView;
  /** Depth texture view (must be `aspect: 'depth-only'` for stencil formats). */
  depthView: GPUTextureView;
}

export class EdlPass {
  private device: GPUDevice;
  private colorFormat: GPUTextureFormat;
  private isMultisampled: boolean;
  private uniformBuffer: GPUBuffer;
  private uniformStaging = new Float32Array(4);
  private bindGroupLayout: GPUBindGroupLayout;
  private pipeline: GPURenderPipeline;
  private cachedBindGroup: GPUBindGroup | null = null;
  private cachedDepthView: GPUTextureView | null = null;
  private destroyed = false;

  constructor(device: WebGPUDevice, sampleCount: number) {
    this.device = device.getDevice();
    this.colorFormat = device.getFormat();
    this.isMultisampled = sampleCount > 1;

    this.uniformBuffer = this.device.createBuffer({
      // strength, radiusPx, highQuality(u32-as-f32 placeholder), pad
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: {
            sampleType: 'depth',
            viewDimension: '2d',
            multisampled: this.isMultisampled,
          },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
      ],
    });

    const depthTexDecl = this.isMultisampled
      ? '@group(0) @binding(0) var depthTex: texture_depth_multisampled_2d;'
      : '@group(0) @binding(0) var depthTex: texture_depth_2d;';
    const depthLoadExpr = this.isMultisampled
      // sample_index for texture_depth_multisampled_2d must be i32 per
      // the WGSL spec; some browsers accept the unsigned form, but
      // strict validators (Naga) reject it.
      ? 'textureLoad(depthTex, c, 0)'
      : 'textureLoad(depthTex, c, 0)';

    const shader = this.device.createShaderModule({
      code: `
struct Params {
  strength: f32,
  radiusPx: f32,
  highQuality: f32,
  _pad: f32,
}

${depthTexDecl}
@group(0) @binding(1) var<uniform> params: Params;

struct VsOut {
  @builtin(position) pos: vec4<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) v: u32) -> VsOut {
  // Standard fullscreen triangle (covers viewport, no UVs needed since
  // the fragment shader reads from textureLoad with @builtin(position)).
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 3.0,  1.0)
  );
  var o: VsOut;
  o.pos = vec4<f32>(p[v], 0.0, 1.0);
  return o;
}

fn sampleDepthClamped(ip: vec2<i32>, dims: vec2<i32>) -> f32 {
  let c = vec2<i32>(clamp(ip.x, 0, dims.x - 1), clamp(ip.y, 0, dims.y - 1));
  return ${depthLoadExpr};
}

@fragment
fn fs_main(@builtin(position) fragPos: vec4<f32>) -> @location(0) vec4<f32> {
  let dimsU = textureDimensions(depthTex);
  let dims = vec2<i32>(i32(dimsU.x), i32(dimsU.y));
  let p = vec2<i32>(i32(fragPos.x), i32(fragPos.y));

  let center = sampleDepthClamped(p, dims);
  // Reverse-Z: 0 = far plane (no geometry written here), so skip.
  if (center <= 1e-5) {
    return vec4<f32>(0.0, 0.0, 0.0, 0.0);
  }

  let r = max(1, i32(params.radiusPx));
  let logCenter = log(center);

  var accum = 0.0;
  var count = 0.0;

  // Cardinal taps
  let neighbourOffsets4 = array<vec2<i32>, 4>(
    vec2<i32>( r,  0),
    vec2<i32>(-r,  0),
    vec2<i32>( 0,  r),
    vec2<i32>( 0, -r),
  );
  for (var i = 0; i < 4; i = i + 1) {
    let dn = sampleDepthClamped(p + neighbourOffsets4[i], dims);
    if (dn > 1e-5) {
      // log(centre) - log(dn) > 0 when neighbour is further (smaller depth)
      // → darken silhouette edges.
      accum = accum + max(0.0, logCenter - log(dn));
      count = count + 1.0;
    }
  }

  if (params.highQuality > 0.5) {
    let neighbourOffsets8 = array<vec2<i32>, 4>(
      vec2<i32>( r,  r),
      vec2<i32>(-r,  r),
      vec2<i32>( r, -r),
      vec2<i32>(-r, -r),
    );
    for (var i = 0; i < 4; i = i + 1) {
      let dn = sampleDepthClamped(p + neighbourOffsets8[i], dims);
      if (dn > 1e-5) {
        accum = accum + max(0.0, logCenter - log(dn));
        count = count + 1.0;
      }
    }
  }

  let meanLog = accum / max(count, 1.0);
  // exp(-300 * meanLog * strength) — 300 matches Potree's default sensitivity.
  // Output (1 - shade) as alpha; the blend mode multiplies dst by (1 - alpha).
  let shade = exp(-300.0 * meanLog * params.strength);
  let darken = clamp(1.0 - shade, 0.0, 0.85);
  return vec4<f32>(0.0, 0.0, 0.0, darken);
}
`,
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: { module: shader, entryPoint: 'vs_main' },
      fragment: {
        module: shader,
        entryPoint: 'fs_main',
        targets: [{
          format: this.colorFormat,
          // Same darken-overlay blend as the existing PostProcessor:
          // dst' = dst * (1 - srcAlpha), src colour discarded.
          blend: {
            color: { srcFactor: 'zero', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'zero', dstFactor: 'one' },
          },
        }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  apply(encoder: GPUCommandEncoder, opts: EdlPassApplyOptions, params: Required<EdlPassOptions>): void {
    if (this.destroyed) return;
    if (this.cachedBindGroup === null || this.cachedDepthView !== opts.depthView) {
      this.cachedBindGroup = this.device.createBindGroup({
        layout: this.bindGroupLayout,
        entries: [
          { binding: 0, resource: opts.depthView },
          { binding: 1, resource: { buffer: this.uniformBuffer } },
        ],
      });
      this.cachedDepthView = opts.depthView;
    }
    this.uniformStaging[0] = params.strength;
    this.uniformStaging[1] = params.radiusPx;
    this.uniformStaging[2] = params.highQuality ? 1 : 0;
    this.uniformStaging[3] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformStaging);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: opts.targetView,
        loadOp: 'load',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.cachedBindGroup);
    pass.draw(3, 1, 0, 0);
    pass.end();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.uniformBuffer.destroy();
    this.cachedBindGroup = null;
    this.cachedDepthView = null;
  }
}
