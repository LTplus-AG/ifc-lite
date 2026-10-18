/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { guardedMeshShader, unbiasedMeshShader, OPAQUE_VISIBILITY_GROUP } from './shaders/opaque-visibility.wgsl.js';
import { mainShaderSource } from './shaders/main.wgsl.js';
import { setOpaqueVisibilityCommands } from './opaque-visibility-commands.js';
import { opaqueVisibilityTimestampWrites } from './renderer-frame-timing.js';

const layouts = new WeakMap<GPUDevice, Map<number, GPUBindGroupLayout>>();

export function opaqueVisibilityLayout(device: GPUDevice, samples: number): GPUBindGroupLayout {
  let bySamples = layouts.get(device);
  if (!bySamples) { bySamples = new Map(); layouts.set(device, bySamples); }
  let layout = bySamples.get(samples);
  if (!layout) {
    layout = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: 'depth', multisampled: samples > 1 } }] });
    bySamples.set(samples, layout);
  }
  return layout;
}

interface Registration { descriptor: GPURenderPipelineDescriptor; source: string }
interface Variants { colour: GPURenderPipeline; depth: GPURenderPipeline | null }
class PendingVisibility extends Error {
  constructor(readonly ready: Promise<void>, readonly alive: () => boolean) { super('Orthographic pipelines are compiling'); }
}

/** A compiling frame is discarded before submit; completion requests its replacement. */
export function deferOpaqueVisibilityFrame(error: unknown, requestRender: () => void): boolean {
  if (!(error instanceof PendingVisibility)) return false;
  const wake = () => { if (error.alive()) requestRender(); };
  void error.ready.then(wake, wake); // Rejection is retained and thrown on the next draw.
  return true;
}

/**
 * Orthographic only: replay the SAME submitted opaque draws into unbiased
 * sample-matched depth, then constrain the legacy coplanar ranking to it.
 * No second visibility, partial-batch, texture or instancing enumeration.
 */
export class OpaqueVisibilityPass {
  private readonly registrations = new Map<GPURenderPipeline, Registration>();
  private readonly variants = new Map<GPURenderPipeline, Variants>();
  private readonly pending = new Map<GPURenderPipeline, Promise<void>>();
  private readonly failures = new Map<GPURenderPipeline, unknown>();
  private destroyed = false;
  private texture: GPUTexture | null = null;
  private binding: GPUBindGroup | null = null;
  private width = 0;
  private height = 0;
  private active = false;

  constructor(private readonly device: GPUDevice, private readonly samples: number) {}

  create(descriptor: GPURenderPipelineDescriptor, source = mainShaderSource): GPURenderPipeline {
    return this.register(this.device.createRenderPipeline(descriptor), descriptor, source);
  }

  async createAsync(descriptor: GPURenderPipelineDescriptor, source = mainShaderSource): Promise<GPURenderPipeline> {
    return this.register(await this.device.createRenderPipelineAsync(descriptor), descriptor, source);
  }

  register(pipeline: GPURenderPipeline, descriptor: GPURenderPipelineDescriptor, source: string): GPURenderPipeline {
    if (this.destroyed) throw new Error('Visibility pass was destroyed during compilation');
    this.registrations.set(pipeline, { descriptor, source }); return pipeline;
  }

  getBinding(): GPUBindGroup | undefined { return this.active ? this.binding ?? undefined : undefined; }

  private ensureSize(width: number, height: number): void {
    if (this.texture && width === this.width && height === this.height) return;
    this.texture?.destroy(); this.width = width; this.height = height;
    this.texture = this.device.createTexture({ label: 'opaque-geometric-depth', size: [width, height],
      sampleCount: this.samples, format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.binding = this.device.createBindGroup({ layout: opaqueVisibilityLayout(this.device, this.samples),
      entries: [{ binding: 0, resource: this.texture.createView() }] });
  }

  /** Explicit setup for async consumers; the render path requests only used variants. */
  async prepare(base?: GPURenderPipeline): Promise<void> {
    if (!base) { await Promise.all([...this.registrations.keys()].map(pipeline => this.prepare(pipeline))); return; }
    if (this.variants.has(base)) return;
    let ready = this.pending.get(base);
    if (!ready) {
      const registration = this.registrations.get(base);
      if (!registration) return;
      ready = this.buildVariants(base, registration).then(variants => {
        if (!this.destroyed && variants) this.variants.set(base, variants);
      }, error => { this.failures.set(base, error); throw error; });
      this.pending.set(base, ready);
    }
    await ready;
  }

  private forPipeline(base: GPURenderPipeline): Variants | undefined {
    if (this.failures.has(base)) throw this.failures.get(base);
    const variants = this.variants.get(base);
    if (variants || !this.registrations.get(base)?.descriptor.fragment) return variants;
    throw new PendingVisibility(this.prepare(base), () => !this.destroyed);
  }

  private async buildVariants(base: GPURenderPipeline, registration: Registration): Promise<Variants | undefined> {
    const { descriptor: d, source } = registration;
    const fragment = d.fragment;
    if (!fragment) return undefined;
    const module = this.device.createShaderModule({ code: guardedMeshShader(source, this.samples, fragment.entryPoint ?? 'fs_main') });
    const colour = await this.device.createRenderPipelineAsync({ ...d,
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [base.getBindGroupLayout(0), base.getBindGroupLayout(1), opaqueVisibilityLayout(this.device, this.samples)] }),
      vertex: { ...d.vertex, module }, fragment: { ...fragment, module } });
    let depth: GPURenderPipeline | null = null;
    if (d.depthStencil?.depthWriteEnabled) {
      const unbiased = this.device.createShaderModule({ code: unbiasedMeshShader(source, this.samples, fragment.entryPoint ?? 'fs_main') });
      depth = await this.device.createRenderPipelineAsync({ ...d, vertex: { ...d.vertex, module: unbiased },
        fragment: { module: unbiased, entryPoint: 'fs_geometric_depth', targets: [] },
        depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' } });
    }
    return { colour, depth };
  }

  begin(encoder: GPUCommandEncoder, descriptor: GPURenderPassDescriptor, orthographic: boolean, width: number, height: number): GPURenderPassEncoder {
    this.active = orthographic;
    const main = encoder.beginRenderPass(descriptor);
    if (!orthographic) { this.releaseTexture(); return main; }
    this.ensureSize(width, height);
    const before = this.device.createCommandEncoder({ label: 'opaque-visibility-before-main' });
    const depthPass = before.beginRenderPass({
      timestampWrites: opaqueVisibilityTimestampWrites(encoder, before),
      colorAttachments: [],
      depthStencilAttachment: { view: this.texture!.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    let variant: Variants | undefined;
    const groups = new Map<number, unknown[]>(), vertices = new Map<number, unknown[]>();
    let indices: unknown[] | undefined;
    const raster = new Map<string, unknown[]>();
    const methods = new Map<PropertyKey, unknown>();
    const invoke = (pass: GPURenderPassEncoder, name: PropertyKey, args: unknown[]) => Reflect.apply(Reflect.get(pass, name), pass, args);
    const draw = (name: PropertyKey, args: unknown[]) => {
      if (variant?.depth) {
        depthPass.setPipeline(variant.depth);
        for (const [group, args] of groups) if (group < OPAQUE_VISIBILITY_GROUP) invoke(depthPass, 'setBindGroup', args);
        for (const args of vertices.values()) invoke(depthPass, 'setVertexBuffer', args);
        if (indices) invoke(depthPass, 'setIndexBuffer', indices);
        for (const [method, args] of raster) invoke(depthPass, method, args);
        invoke(depthPass, name, args);
      }
      if (variant) main.setBindGroup(OPAQUE_VISIBILITY_GROUP, this.binding!);
      invoke(main, name, args);
    };
    // Proxy retains the actual pass API for existing mesh/overlay helpers. Only
    // orthographic frames pay interception; perspective returns the real pass.
    return new Proxy(main, { get: (target, key) => {
      if (methods.has(key)) return methods.get(key);
      const member: unknown = Reflect.get(target, key);
      if (typeof member !== 'function') return member;
      const method = (...args: unknown[]) => {
        if (key === 'setPipeline') {
          variant = this.forPipeline(args[0] as GPURenderPipeline);
          return main.setPipeline(variant?.colour ?? args[0] as GPURenderPipeline);
        }
        if (key === 'setBindGroup') groups.set(args[0] as number, args);
        if (key === 'setVertexBuffer') vertices.set(args[0] as number, args);
        if (key === 'setIndexBuffer') indices = args;
        if (key === 'setViewport' || key === 'setScissorRect' || key === 'setBlendConstant') raster.set(key, args);
        if (key === 'draw' || key === 'drawIndexed' || key === 'drawIndirect' || key === 'drawIndexedIndirect') return draw(key, args);
        if (key === 'executeBundles') throw new Error('Opaque visibility requires prepared draws, not an opaque render bundle');
        if (key === 'end') { depthPass.end(); setOpaqueVisibilityCommands(encoder, before.finish()); }
        return Reflect.apply(member, target, args);
      };
      methods.set(key, method); return method;
    } });
  }

  private releaseTexture(): void {
    this.texture?.destroy(); this.texture = null; this.binding = null; this.width = 0; this.height = 0;
  }

  destroy(): void {
    this.destroyed = true; this.releaseTexture(); this.variants.clear(); this.registrations.clear(); this.failures.clear(); this.pending.clear();
  }
}
