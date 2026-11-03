/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * GPU half of the nearest-glass split (#8564): the per-sample nearest transparent
 * depth P1 and a count of samples covered by two or more transparent surfaces.
 * Both replay the recorded transparent draws through depth-only variants of
 * their own pipelines: same vertex stage (and depth nudge), same fragment
 * discards (clipping, X-Ray, instanced opacity routing), no colour.
 */

import type { GaussianCompositionFallback, GaussianTransparentLayers } from './gaussian-composition.js';
import type { DeferredPassRecorder } from './gaussian-pass-recorder.js';

interface Registration { readonly descriptor: GPURenderPipelineDescriptor; readonly source: string }
export type DescribePipeline = (pipeline: GPURenderPipeline) => Readonly<Registration> | undefined;

interface Variants { readonly nearest: GPURenderPipeline; readonly count: GPURenderPipeline | null }

export interface GlassDepthFrame {
  readonly encoder: GPUCommandEncoder;
  /** The main depth-stencil attachment (all aspects); read-only here except for a cleared stencil. */
  readonly depthView: GPUTextureView;
  readonly depthFormat: GPUTextureFormat;
  readonly sampleCount: number;
  readonly width: number;
  readonly height: number;
  /** Bind groups the transparent draws inherit from the main pass. */
  readonly initial: ReadonlyArray<readonly [number, GPUBindGroup]>;
}

/** The base fragment as a plain function, called by a colourless entry so its discards still apply. */
export function glassDepthShader(source: string, entryPoint = 'fs_main'): string {
  const entry = source.indexOf(`fn ${entryPoint}(input: VertexOutput)`);
  const attribute = source.lastIndexOf('@fragment', entry);
  if (entry < 0 || attribute < 0 || source.slice(attribute + '@fragment'.length, entry).trim() !== '') {
    throw new Error(`Glass depth variant: no '@fragment fn ${entryPoint}(input: VertexOutput)' entry`);
  }
  return `${source.slice(0, attribute)}${source.slice(attribute + '@fragment'.length)}
@fragment fn fs_glass_depth(input: VertexOutput) { _ = ${entryPoint}(input); }
`;
}

const COUNT_SHADER = `
@vertex fn vs(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
  let corner = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4<f32>(corner * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs() {}
`;
const INCREMENT: GPUStencilFaceState = { compare: 'always', passOp: 'increment-clamp', failOp: 'keep', depthFailOp: 'keep' };
const hasStencil = (format: GPUTextureFormat) => format.includes('stencil8');

export class GaussianGlassSplit {
  private readonly variants = new Map<GPURenderPipeline, Variants | Promise<void> | Error>();
  private nearest: { texture: GPUTexture; key: string } | null = null;
  private quad: GPURenderPipeline | null = null;
  private query: { set: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer } | null = null;
  private frame = 0;
  /** The frame whose count was encoded and still awaits submission (-1: none). */
  private queried = -1;
  private reading = false;
  /** The latest frame split but could not encode its own count (an earlier one was still reading). */
  private missing = false;
  private destroyed = false;
  /** The count of the latest splat frame only; `unknown` until that frame's own query reads back. */
  layers: GaussianTransparentLayers = 'unknown';
  /** That query's raw result, for diagnostics: a sample count, or any positive value where occlusion is binary (D3D12). */
  layerSamples: number | null = null;

  /** `onReady`: variants compiled or a count is needed, render again. `onResult`: the latest frame's count arrived. */
  constructor(private readonly device: GPUDevice, private readonly onReady: () => void, private readonly onResult: () => void = () => {}) {}

  /** Every splat frame, split or not: earlier counts no longer describe the frame and are dropped. */
  beginFrame(): void {
    this.frame++;
    this.layers = 'unknown';
    this.layerSamples = null;
    this.queried = -1; // an encoded but unsubmitted count (a deferred frame) never executes
    this.missing = false;
  }

  /** Null when every glass pipeline has its variants; else why this frame cannot split. Missing variants start compiling. */
  prepare(pipelines: ReadonlySet<GPURenderPipeline>, describe: DescribePipeline): GaussianCompositionFallback | null {
    let compiling = false;
    for (const pipeline of pipelines) {
      let entry = this.variants.get(pipeline);
      if (!entry) {
        const registration = describe(pipeline);
        if (!registration?.descriptor.fragment || !registration.descriptor.depthStencil) return 'unsupported-draw';
        entry = this.build(pipeline, registration);
      }
      if (entry instanceof Error) return 'unsupported-draw';
      if (entry instanceof Promise) compiling = true;
    }
    return compiling ? 'pipelines-compiling' : null;
  }

  /** Encode P1 and, when no earlier count is still reading back, the layer count. Returns P1 (depth32float). */
  encodeNearest(frame: GlassDepthFrame, recorder: DeferredPassRecorder): GPUTexture {
    const texture = this.target(frame);
    const pass = frame.encoder.beginRenderPass({
      label: 'ifc-lite-gaussian-nearest-transparent', colorAttachments: [],
      depthStencilAttachment: { view: texture.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    try {
      recorder.replay(pass, { depthOnly: (pipeline) => this.ready(pipeline).nearest, initial: frame.initial });
    } finally { pass.end(); }
    if (this.reading || !hasStencil(frame.depthFormat)) this.missing = hasStencil(frame.depthFormat);
    else { this.encodeCount(frame, recorder); this.queried = this.frame; }
    return texture;
  }

  /**
   * Call once the frame's command buffer is submitted; reads its count back. The result is
   * published only if no later splat frame began meanwhile; a stale result is dropped.
   */
  submitted(): void {
    if (this.queried !== this.frame || !this.query) return;
    const token = this.frame, read = this.query.read;
    this.queried = -1;
    this.reading = true;
    void this.readLayers(token, read);
  }

  /** Readback is diagnostic: processing/callback failures must never reject into the frame loop. */
  private async readLayers(token: number, read: GPUBuffer): Promise<void> {
    let mapped = false;
    try {
      await read.mapAsync(GPUMapMode.READ);
      mapped = true;
      if (this.destroyed) return;
      const samples = Number(new BigUint64Array(read.getMappedRange(0, 8))[0]);
      read.unmap();
      mapped = false;
      if (token !== this.frame) return;
      this.layers = samples > 0 ? 'multiple' : 'single';
      this.layerSamples = samples;
      this.onResult();
    } catch (error) {
      if (token === this.frame) { this.layers = 'unknown'; this.layerSamples = null; }
      console.error('[Gaussian] glass layer readback failed; count stays unknown:', error);
    } finally {
      if (mapped) {
        try { read.unmap(); }
        catch (error) {
          console.error('[Gaussian] glass layer buffer could not unmap; releasing query resources:', error);
          const query = this.query;
          if (query?.read === read) {
            this.query = null; // recreate the slot next frame instead of reusing a mapped buffer
            for (const resource of [query.set, query.resolve, query.read]) {
              try { resource.destroy(); }
              catch (releaseError) { console.error('[Gaussian] glass query release failed:', releaseError); }
            }
          }
        }
      }
      this.reading = false;
      if (this.missing && !this.destroyed) {
        try { this.onReady(); } // the latest frame has no count of its own yet
        catch (error) { console.error('[Gaussian] glass layer redraw callback failed:', error); }
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.nearest?.texture.destroy();
    this.nearest = null;
    for (const resource of this.query ? [this.query.set, this.query.resolve, this.query.read] : []) resource?.destroy();
    this.query = null;
    this.variants.clear();
  }

  private encodeCount(frame: GlassDepthFrame, recorder: DeferredPassRecorder): void {
    const query = this.query ??= {
      set: this.device.createQuerySet({ label: 'ifc-lite-gaussian-transparent-layers', type: 'occlusion', count: 1 }),
      resolve: this.device.createBuffer({ label: 'ifc-lite-gaussian-layers-resolve', size: 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
      read: this.device.createBuffer({ label: 'ifc-lite-gaussian-layers-read', size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    };
    // Stencil counts transparent fragments in front of opaque depth per sample; the
    // quad then counts samples where that is two or more.
    const pass = frame.encoder.beginRenderPass({
      label: 'ifc-lite-gaussian-transparent-layers', colorAttachments: [], occlusionQuerySet: query.set,
      depthStencilAttachment: { view: frame.depthView, depthReadOnly: true, stencilClearValue: 0, stencilLoadOp: 'clear', stencilStoreOp: 'discard' },
    });
    try {
      recorder.replay(pass, { depthOnly: (pipeline) => this.ready(pipeline).count!, initial: frame.initial });
      const module = this.quad ? null : this.device.createShaderModule({ label: 'ifc-lite-gaussian-layer-count', code: COUNT_SHADER });
      pass.setPipeline(this.quad ??= this.device.createRenderPipeline({
        label: 'ifc-lite-gaussian-layer-count', layout: 'auto',
        vertex: { module: module!, entryPoint: 'vs' },
        fragment: { module: module!, entryPoint: 'fs', targets: [] },
        depthStencil: { format: frame.depthFormat, depthWriteEnabled: false, depthCompare: 'always', stencilReadMask: 0xff, stencilWriteMask: 0,
          stencilFront: { compare: 'less-equal' }, stencilBack: { compare: 'less-equal' } },
        multisample: { count: frame.sampleCount },
      }));
      pass.setStencilReference(2);
      pass.beginOcclusionQuery(0);
      pass.draw(3);
      pass.endOcclusionQuery();
    } finally { pass.end(); }
    frame.encoder.resolveQuerySet(query.set, 0, 1, query.resolve, 0);
    frame.encoder.copyBufferToBuffer(query.resolve, 0, query.read, 0, 8);
  }

  private ready(pipeline: GPURenderPipeline): Variants {
    const entry = this.variants.get(pipeline);
    if (!entry || entry instanceof Promise || entry instanceof Error) throw new Error('Glass depth variant used before prepare()');
    return entry;
  }

  private build(base: GPURenderPipeline, { descriptor: d, source }: Readonly<Registration>): Promise<void> {
    const promise = (async () => {
      const module = this.device.createShaderModule({ label: 'ifc-lite-gaussian-glass-depth', code: glassDepthShader(source, d.fragment!.entryPoint ?? 'fs_main') });
      const stage = { ...d, vertex: { ...d.vertex, module }, fragment: { module, entryPoint: 'fs_glass_depth', targets: [] } };
      const format = d.depthStencil!.format;
      const [nearest, count] = await Promise.all([
        this.device.createRenderPipelineAsync({ ...stage, label: 'ifc-lite-gaussian-nearest-transparent',
          depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' } }),
        hasStencil(format) ? this.device.createRenderPipelineAsync({ ...stage, label: 'ifc-lite-gaussian-transparent-count',
          depthStencil: { format, depthWriteEnabled: false, depthCompare: 'greater', stencilFront: INCREMENT, stencilBack: INCREMENT } }) : null,
      ]);
      if (!this.destroyed) this.variants.set(base, { nearest, count });
    })().catch((error: unknown) => {
      console.error('[Gaussian] glass depth variant failed; frames using it keep the single splat pass:', error);
      this.variants.set(base, error instanceof Error ? error : new Error(String(error)));
    }).finally(() => { if (!this.destroyed) this.onReady(); });
    this.variants.set(base, promise);
    return promise;
  }

  private target(frame: GlassDepthFrame): GPUTexture {
    const key = `${frame.width}x${frame.height}x${frame.sampleCount}`;
    if (this.nearest?.key !== key) {
      this.nearest?.texture.destroy();
      this.nearest = { key, texture: this.device.createTexture({
        label: 'ifc-lite-gaussian-nearest-transparent-depth', size: [frame.width, frame.height], format: 'depth32float',
        sampleCount: frame.sampleCount, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      }) };
    }
    return this.nearest.texture;
  }
}
