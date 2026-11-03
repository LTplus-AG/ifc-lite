/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Upstream luma.gl Gaussian rendering on the viewer's own GPUDevice (#8564).
 * Loaded lazily by the Gaussian layer; IFC-only sessions never fetch luma.
 *
 * Ownership: the luma `WebGPUDevice` merely wraps the viewer's GPUDevice and is
 * NEVER destroyed (its destroy() would destroy the borrowed device); it dies with
 * that device. Upstream registers an `uncapturederror` listener on the device for
 * the device's lifetime, forwarded to `onError`; it calls `preventDefault()`, so the
 * browser's default console report for every uncaptured error of the shared device
 * is replaced by that callback once Gaussian rendering has started. The viewer's encoder and
 * attachments are borrowed per pass. luma's framebuffer here is a 1x1 format
 * descriptor that luma owns; viewer textures are never wrapped.
 */

import { Texture, type Framebuffer, type TextureFormat } from '@luma.gl/core';
import { WebGPUDevice } from '@luma.gl/webgpu';
import { SplatRenderer, makeGPUSplatData, type GPUSplatData } from '@luma.gl/splats';
import { GaussianSplatError } from './gaussian-errors.js';
import type {
  GaussianBackendFactory, GaussianBackendScene, GaussianDepthInterval, GaussianEncodeCamera, GaussianEncodeTarget,
  GaussianPackedSource, GaussianRowFilter, GaussianRowUpdate,
} from './gaussian-backend.js';

export const createLumaGaussianBackend: GaussianBackendFactory = async (raw, adapter, onError) => {
  const info = adapter?.info;
  if (!adapter || !info) {
    throw new GaussianSplatError('upstream-capability-missing', 'Gaussian rendering needs the WebGPU adapter and its info.');
  }
  // Returning true marks the error handled, so luma does not log it a second time.
  const device = new WebGPUDevice({ id: 'ifc-lite-gaussian-borrowed', onError: (error) => { onError(error); return true; } }, raw, adapter, info);
  // The installed renderer must order reverse-Z depth back to front (luma.gl #3619,
  // applied as patches/@luma.gl__splats@9.4.2.patch). Unpatched builds ignore the prop.
  // The nearest-glass split also needs the depth-interval hook of that patch (#8564).
  const probe = new SplatRenderer(device, { depthConvention: 'reverse', depthIntervalSamples: 4 });
  const upstreamReverseZ = probe.props.depthConvention === 'reverse';
  const upstreamDepthInterval = probe.props.depthIntervalSamples === 4;
  probe.destroy();
  return { upstreamReverseZ, upstreamDepthInterval, createScene: () => new LumaGaussianScene(device, raw) };
};

class LumaGaussianScene implements GaussianBackendScene {
  private data: GPUSplatData | null = null;
  private renderer: SplatRenderer | null = null;
  /** Same data, filter and sort as `renderer`, drawn through the depth-interval shader; built on the first split frame. */
  private interval: SplatRenderer | null = null;
  private bound: { texture: GPUTexture; wrapper: Texture } | null = null;
  private filter: { include: ReadonlySet<number>; predicate?: GaussianRowFilter } = { include: new Set() };
  private formats: { key: string; framebuffer: Framebuffer; textures: Texture[] } | null = null;
  private destroyed = false;

  constructor(private readonly device: WebGPUDevice, private readonly raw: GPUDevice) {}

  /** Source columns plus the full-size sorted index buffer; pipelines and attachments excluded. */
  get gpuBytes(): number {
    return this.data ? this.data.byteLength + this.data.length * Uint32Array.BYTES_PER_ELEMENT : 0;
  }

  async replaceSource(source: GaussianPackedSource): Promise<void> {
    this.raw.pushErrorScope('out-of-memory');
    this.raw.pushErrorScope('validation');
    let data: GPUSplatData | null = null;
    let thrown: unknown = null;
    try {
      data = makeGPUSplatData(this.device, {
        positions: source.positions, scales: source.scales, rotations: source.rotations, colors: source.colors,
        opacities: source.opacities, semanticIds: source.semanticIds,
        ...(source.sphericalHarmonicsDegree > 0
          ? { sphericalHarmonics: source.sphericalHarmonics, sphericalHarmonicsDegree: source.sphericalHarmonicsDegree }
          : {}),
      });
    } catch (error) {
      thrown = error;
    }
    const validation = this.raw.popErrorScope();
    const memory = this.raw.popErrorScope();
    const [invalid, outOfMemory] = await Promise.all([validation, memory]);
    if (thrown || invalid || outOfMemory || !data || this.destroyed) {
      data?.destroy();
      if (this.destroyed) throw new GaussianSplatError('lost', 'The Gaussian scene was released during upload.');
      const reason = thrown instanceof Error ? thrown.message : (outOfMemory ?? invalid)?.message ?? 'unknown';
      throw new GaussianSplatError('resource-limit', `Gaussian upload failed: ${reason}`);
    }
    this.interval?.setProps({ data });
    if (this.renderer) {
      this.renderer.setProps({ data });
    } else {
      this.renderer = new SplatRenderer(this.device, {
        data, depthConvention: 'reverse', depthCompare: 'greater', depthWriteEnabled: false,
        toneMapping: 'none', sortMode: 'global', semanticFilter: this.filter,
      });
    }
    this.data?.destroy();
    this.data = data;
  }

  updateRows(rowOffset: number, rows: GaussianRowUpdate): void {
    this.data?.update({ rowOffset, ...rows });
  }

  setFilter(include: ReadonlySet<number>, predicate: GaussianRowFilter | null): void {
    this.filter = predicate ? { include: new Set(include), predicate } : { include: new Set(include) };
    this.renderer?.setProps({ semanticFilter: this.filter });
    this.interval?.setProps({ semanticFilter: this.filter });
  }

  encode(target: GaussianEncodeTarget, camera: GaussianEncodeCamera, interval?: GaussianDepthInterval): void {
    // Split preparation can fail before recording, but draw/cleanup can fail afterwards. The caller
    // must never retry splats in this frame. Single-pass preparation stays inside its resolving pass.
    const prepared = interval ? { renderer: this.prepare(target, camera, interval) } : null;
    const pass = target.encoder.beginRenderPass({
      label: 'ifc-lite-gaussian-splats',
      colorAttachments: [{
        view: target.colorView, resolveTarget: target.resolveTarget,
        loadOp: 'load', storeOp: target.resolveTarget ? 'discard' : 'store',
      }],
      depthStencilAttachment: { view: target.depthView, depthReadOnly: true, stencilReadOnly: true },
    });
    try {
      const renderer = prepared ? prepared.renderer : this.prepare(target, camera);
      if (!renderer) return;
      const lumaPass = this.device.beginRenderPass({ handle: pass, framebuffer: this.formatDescriptor(target) });
      try {
        renderer.draw(lumaPass);
      } finally {
        lumaPass.destroy();
      }
    } finally {
      pass.end();
    }
  }

  /** Camera, viewport, sample count and (split draws) the interval bound; null with nothing to draw. */
  private prepare(target: GaussianEncodeTarget, camera: GaussianEncodeCamera, interval?: GaussianDepthInterval): SplatRenderer | null {
    const renderer = interval ? this.intervalRenderer(target.sampleCount) : this.renderer;
    if (!renderer || !this.data) return null;
    renderer.setProps({
      modelViewProjectionMatrix: camera.modelViewProjection,
      viewportSize: [target.width, target.height],
      cameraPosition: camera.cameraPosition,
      ...(interval && { depthInterval: { bound: this.wrap(interval.bound), compare: interval.compare } }),
    });
    const model = renderer.model;
    if (model && model.parameters.sampleCount !== target.sampleCount) {
      model.setParameters({ ...model.parameters, sampleCount: target.sampleCount });
    }
    this.formatDescriptor(target);
    return renderer;
  }

  captureDiagnostics(): Record<string, unknown> {
    const renderer = this.renderer;
    let hash = 2166136261;
    for (const row of renderer?.sortedReferences ?? []) {
      hash = Math.imul(hash ^ row.rowIndex, 16777619) >>> 0;
    }
    return { sortIndexFnv32: hash, sortCount: renderer?.sortedReferences.length ?? 0,
      modelViewProjection: Array.from(renderer?.props.modelViewProjectionMatrix ?? []),
      cameraPosition: Array.from(renderer?.props.cameraPosition ?? []),
      viewportSize: renderer?.props.viewportSize, sourceHash: 'not exposed; fixture SHA and source binding retained separately' };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.interval?.destroy();
    this.interval = null;
    this.bound?.wrapper.destroy(); // the wrapper only; the split owns the texture
    this.bound = null;
    this.renderer?.destroy();
    this.renderer = null;
    this.data?.destroy();
    this.data = null;
    this.releaseFormats();
  }

  private intervalRenderer(samples: number): SplatRenderer | null {
    if (!this.renderer || !this.data) return null;
    if (this.interval && this.interval.props.depthIntervalSamples !== samples) { this.interval.destroy(); this.interval = null; }
    return this.interval ??= new SplatRenderer(this.device, {
      data: this.data, depthConvention: 'reverse', depthCompare: 'greater', depthWriteEnabled: false,
      toneMapping: 'none', sortMode: 'global', semanticFilter: this.filter, depthIntervalSamples: samples,
    });
  }

  /** A luma view of the split's bound texture; luma never owns or destroys it. */
  private wrap(texture: GPUTexture): Texture {
    if (this.bound?.texture === texture) return this.bound.wrapper;
    this.bound?.wrapper.destroy();
    const wrapper = this.device.createTexture({
      id: 'ifc-lite-gaussian-interval-bound', handle: texture, width: texture.width, height: texture.height,
      format: lumaDepthFormat(texture.format), samples: texture.sampleCount, usage: texture.usage,
    });
    this.bound = { texture, wrapper };
    return wrapper;
  }

  /** luma derives pipeline formats and sample count from this; the real attachments stay the viewer's. */
  private formatDescriptor(target: GaussianEncodeTarget): Framebuffer {
    const color = lumaColorFormat(target.colorFormat);
    const depth = lumaDepthFormat(target.depthFormat);
    const key = `${color}|${depth}|${target.sampleCount}`;
    if (this.formats?.key === key) return this.formats.framebuffer;
    this.releaseFormats();
    const texture = (format: TextureFormat) => this.device.createTexture({
      id: `ifc-lite-gaussian-format-${format}`, width: 1, height: 1, format, samples: target.sampleCount,
      usage: Texture.RENDER_ATTACHMENT,
    });
    const textures = [texture(color), texture(depth)];
    const framebuffer = this.device.createFramebuffer({
      id: 'ifc-lite-gaussian-format', width: 1, height: 1, colorAttachments: [textures[0]], depthStencilAttachment: textures[1],
    });
    this.formats = { key, framebuffer, textures };
    return framebuffer;
  }

  private releaseFormats(): void {
    if (!this.formats) return;
    this.formats.framebuffer.destroy();
    for (const texture of this.formats.textures) texture.destroy();
    this.formats = null;
  }
}

function lumaColorFormat(format: GPUTextureFormat): TextureFormat {
  switch (format) {
    case 'bgra8unorm': return 'bgra8unorm';
    case 'rgba8unorm': return 'rgba8unorm';
    case 'rgba16float': return 'rgba16float';
    default: throw new GaussianSplatError('upstream-capability-missing', `Unsupported Gaussian colour target ${format}.`);
  }
}

function lumaDepthFormat(format: GPUTextureFormat): TextureFormat {
  switch (format) {
    case 'depth24plus-stencil8': return 'depth24plus-stencil8';
    case 'depth32float': return 'depth32float';
    case 'depth24plus': return 'depth24plus';
    default: throw new GaussianSplatError('upstream-capability-missing', `Unsupported Gaussian depth target ${format}.`);
  }
}
