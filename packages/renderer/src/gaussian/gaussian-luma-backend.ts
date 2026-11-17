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

import { Buffer, Texture, type Framebuffer, type TextureFormat } from '@luma.gl/core';
import { WebGPUDevice } from '@luma.gl/webgpu';
import { SplatRenderer, makeGPUSplatData, type GPUSplatData } from '@luma.gl/splats';
import { GaussianSplatError } from './gaussian-errors.js';
import type {
  GaussianBackendFactory, GaussianBackendScene, GaussianDepthInterval, GaussianEncodeCamera, GaussianEncodeTarget,
  GaussianGpuRows, GaussianPackedLayout, GaussianRowFilter, GaussianRowWriter, GaussianSortColumns,
} from './gaussian-backend.js';
import { shBasisCount, shWords } from './gaussian-pack.js';

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

  async replaceRows(layout: GaussianPackedLayout, fill: (writer: GaussianRowWriter) => Promise<GaussianSortColumns>): Promise<void> {
    const columns = new Map<GpuColumn, Buffer>();
    const scopes: Promise<GPUError | null>[] = [];
    const scoped = (work: () => void) => {
      this.raw.pushErrorScope('out-of-memory');
      this.raw.pushErrorScope('validation');
      let thrown: unknown = null;
      try { work(); } catch (error) { thrown = error; }
      scopes.push(this.raw.popErrorScope(), this.raw.popErrorScope());
      if (thrown) throw thrown;
    };
    let data: GPUSplatData | null = null;
    try {
      // GPU-only columns: only the sort columns returned by `fill` stay on the CPU (#9018).
      scoped(() => {
        for (const [name, bytes] of columnBytes(layout)) {
          columns.set(name, this.device.createBuffer({
            id: `ifc-lite-gaussian-${name}`, byteLength: Math.max(4, bytes),
            usage: Buffer.VERTEX | Buffer.COPY_DST | Buffer.COPY_SRC | Buffer.STORAGE,
          }));
        }
      });
      const current = this.data;
      const writer: GaussianRowWriter = {
        write: (row, rows) => scoped(() => writeColumns(columns, layout, row, rows)),
        copy: (fromRow, toRow, rows) => scoped(() => {
          if (!current || current.destroyed) throw new GaussianSplatError('lost', 'The Gaussian rows to copy were released.');
          const encoder = this.raw.createCommandEncoder({ label: 'ifc-lite-gaussian-repack' });
          for (const [name, buffer] of columns) {
            const [from, to, bytes] = columnSpan(name, layout, fromRow, toRow, rows);
            if (bytes > 0) encoder.copyBufferToBuffer(sourceBuffer(current, name).handle as GPUBuffer, from, buffer.handle as GPUBuffer, to, bytes);
          }
          this.raw.queue.submit([encoder.finish()]);
        }),
      };
      const sort = await fill(writer);
      if (this.destroyed) throw new GaussianSplatError('lost', 'The Gaussian scene was released during upload.');
      scoped(() => {
        const sh = columns.get('sphericalHarmonics');
        data = makeGPUSplatData(this.device, {
          positions: sort.positions, opacities: sort.opacities, semanticIds: sort.semanticIds,
          colorFormat: 'float32x4', gpuColumns: Object.fromEntries(columns),
          ...(sh ? { sphericalHarmonicsDegree: layout.shDegree, sphericalHarmonicsEncoding: layout.shEncoding } : {}),
        });
      });
      columns.clear(); // owned by `data` now
      const errors = (await Promise.all(scopes)).filter((error): error is GPUError => error !== null);
      if (errors.length > 0) throw new GaussianSplatError('resource-limit', `Gaussian upload failed: ${errors[0].message}`);
      if (this.destroyed) throw new GaussianSplatError('lost', 'The Gaussian scene was released during upload.');
    } catch (error) {
      (data as GPUSplatData | null)?.destroy();
      for (const buffer of columns.values()) buffer.destroy();
      await Promise.allSettled(scopes); // every pushed scope is popped and settled before failing
      if (this.destroyed) throw new GaussianSplatError('lost', 'The Gaussian scene was released during upload.');
      if (error instanceof GaussianSplatError) throw error;
      throw new GaussianSplatError('resource-limit', `Gaussian upload failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const next = data as unknown as GPUSplatData;
    this.interval?.setProps({ data: next });
    if (this.renderer) {
      this.renderer.setProps({ data: next });
    } else {
      this.renderer = new SplatRenderer(this.device, {
        data: next, depthConvention: 'reverse', depthCompare: 'greater', depthWriteEnabled: false,
        toneMapping: 'none', sortMode: 'global', semanticFilter: this.filter,
      });
    }
    this.data?.destroy();
    this.data = next;
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

type GpuColumn = 'positions' | 'scales' | 'rotations' | 'colors' | 'opacities' | 'semanticIds' | 'sphericalHarmonics';
const ROW_BYTES: ReadonlyArray<[Exclude<GpuColumn, 'sphericalHarmonics'>, number]> = [
  ['positions', 12], ['scales', 12], ['rotations', 16], ['colors', 16], ['opacities', 4], ['semanticIds', 4],
];

function columnBytes(layout: GaussianPackedLayout): Array<[GpuColumn, number]> {
  const columns: Array<[GpuColumn, number]> = ROW_BYTES.map(([name, bytes]) => [name, layout.rows * bytes]);
  if (layout.shDegree > 0) columns.push(['sphericalHarmonics', shWords(layout) * 4]);
  return columns;
}

/** Byte offsets of `rows` rows in one column; packed halves start on even rows, so they are word aligned. */
function columnSpan(name: GpuColumn, layout: GaussianPackedLayout, fromRow: number, toRow: number, rows: number): [number, number, number] {
  if (name !== 'sphericalHarmonics') {
    const bytes = ROW_BYTES.find(([column]) => column === name)![1];
    return [fromRow * bytes, toRow * bytes, rows * bytes];
  }
  const coefficients = shBasisCount(layout.shDegree) * 3;
  if (layout.shEncoding === 'float32') return [fromRow * coefficients * 4, toRow * coefficients * 4, rows * coefficients * 4];
  if ((fromRow | toRow) & 1) throw new RangeError('Packed Gaussian coefficients must start on an even row.');
  return [fromRow * coefficients * 2, toRow * coefficients * 2, Math.ceil((rows * coefficients) / 2) * 4];
}

function writeColumns(columns: ReadonlyMap<GpuColumn, Buffer>, layout: GaussianPackedLayout, row: number, rows: GaussianGpuRows): void {
  const count = rows.opacities.length;
  for (const [name, buffer] of columns) {
    const values = rows[name];
    if (!values) throw new RangeError(`Gaussian rows lack the ${name} column.`);
    buffer.write(values, columnSpan(name, layout, row, row, count)[0]);
  }
}

function sourceBuffer(data: GPUSplatData, name: GpuColumn): Buffer {
  const vector = name === 'sphericalHarmonics' ? data.sphericalHarmonics : name === 'semanticIds' ? data.semanticIds : data[name];
  const buffer = vector?.data[0]?.buffer;
  if (!(buffer instanceof Buffer)) throw new GaussianSplatError('lost', `The drawn Gaussian rows lack the ${name} column.`);
  return buffer;
}
