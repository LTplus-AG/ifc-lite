/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Gaussian captures through the real canonical loader in node (#8565).
 *
 * Real: `useIfcLoader().loadFile`, admission, the worker client, the upstream
 * decoder, normalization, a real `Renderer` and its real `GaussianSplatLayer`
 * (identity-validated handles, packing, budgets, lifecycle), the store and the
 * shared model-index allocator. Faked at the two browser boundaries only: the
 * `Worker` (an in-thread loop that speaks the dedicated worker's message
 * protocol around the real `decodeGaussianFile`) and the WebGPU upload, which a
 * recording backend accepts in place of luma.gl. Pixels are covered by the
 * production-bundle browser journey, not here.
 */

import { Renderer } from '@ifc-lite/renderer';
import type { GaussianBackend, GaussianBackendScene, GaussianPackedSource } from '../../../../packages/renderer/dist/gaussian/gaussian-backend.js';
import { GaussianSplatLayer } from '../../../../packages/renderer/dist/gaussian/gaussian-splat-layer.js';
import { decodeGaussianFile } from '@/hooks/ingest/gaussianDecode';

const BASE = ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
  'scale_0', 'scale_1', 'scale_2', 'opacity', 'f_dc_0', 'f_dc_1', 'f_dc_2'];

/** A binary little-endian Gaussian PLY whose centres are `centres`. */
export function gaussianPly(name: string, centres: Array<[number, number, number]>): File {
  const stride = BASE.length * 4;
  const body = new DataView(new ArrayBuffer(centres.length * stride));
  centres.forEach(([x, y, z], row) => BASE.forEach((property, i) => body.setFloat32(row * stride + i * 4,
    property === 'x' ? x : property === 'y' ? y : property === 'z' ? z : property === 'rot_0' ? 1 : property === 'opacity' ? 2 : 0, true)));
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${centres.length}\n`
    + BASE.map(property => `property float ${property}\n`).join('') + 'end_header\n';
  return new File([header, body.buffer], name);
}

export interface RecordingBackend {
  sources: GaussianPackedSource[];
  /** Hold `replaceSource` (the GPU upload) until released. */
  hold(): () => void;
}

function recordingBackend(): RecordingBackend & { factory: () => Promise<GaussianBackend> } {
  const state: RecordingBackend & { gate: Promise<void> | null } = {
    sources: [], gate: null,
    hold() { let release!: () => void; state.gate = new Promise(resolve => { release = resolve; }); return () => { state.gate = null; release(); }; },
  };
  const scene = (): GaussianBackendScene => ({
    gpuBytes: 0,
    async replaceSource(source) { if (state.gate) await state.gate; state.sources.push(source); },
    updateRows() {}, setFilter() {}, encode() {}, destroy() {},
  });
  return Object.assign(state, { factory: async (): Promise<GaussianBackend> => ({ upstreamReverseZ: true, createScene: scene }) });
}

/** A `Renderer` whose Gaussian layer is the real one on a recording backend. */
export function gaussianTestRenderer(limits = { maxStorageBufferBindingSize: 1 << 28, maxBufferSize: 1 << 28 }) {
  const canvas = { width: 256, height: 256, getBoundingClientRect: () => ({ width: 256, height: 256 }) };
  const renderer = new Renderer(canvas as unknown as HTMLCanvasElement);
  const internals = renderer as unknown as {
    deviceLost: boolean; destroyed: boolean; initGeneration: number; gaussianLayer: GaussianSplatLayer;
    scene: { getModelTranslation(index: number): readonly [number, number, number] | undefined };
  };
  const device = { limits } as unknown as GPUDevice;
  const backend = recordingBackend();
  // `Renderer.init` (the WebGPU adapter) never runs here, so readiness would never publish.
  renderer.isReady = () => true;
  renderer.whenReady = async () => {};
  renderer.requestRender = () => {};
  internals.gaussianLayer = new GaussianSplatLayer({
    lifetime: () => ({ ready: renderer.isReady(), lost: internals.deviceLost, disposed: internals.destroyed, generation: internals.initGeneration }),
    device: () => device, adapter: () => null,
    modelTranslation: (index) => internals.scene.getModelTranslation(index), requestRender: () => {},
    boundsGrew: () => {}, // camera bounds are the renderer's concern, not the loader's
  }, backend.factory);
  return { renderer, backend, loseDevice: () => { internals.deviceLost = true; } };
}

/**
 * Replaces the browser `Worker` with an in-thread loop around the real decoder,
 * speaking `gaussianDecode.worker.ts`'s protocol. `hold` pauses decoding so a
 * test can cancel or supersede the load while the worker is busy.
 */
export function installInThreadGaussianWorker() {
  const saved = globalThis.Worker;
  const stats = { created: 0, terminated: 0, scripts: [] as string[] };
  let gate: Promise<void> | null = null;
  class InThreadGaussianWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    onmessageerror: ((event: MessageEvent) => void) | null = null;
    private terminated = false;
    private readonly decoder: boolean;
    constructor(script: URL | string) {
      stats.scripts.push(String(script));
      // Only the Gaussian decoder runs here; any other worker reports itself
      // unavailable, which its callers already handle (e.g. source identity).
      this.decoder = String(script).includes('gaussianDecode.worker');
      if (this.decoder) stats.created++;
    }
    postMessage(file: File) {
      if (!this.decoder) {
        queueMicrotask(() => this.onerror?.({ message: 'worker unavailable in node' } as ErrorEvent));
        return;
      }
      void (async () => {
        if (gate) await gate;
        let data: unknown;
        try { data = { ok: true, decoded: await decodeGaussianFile(file) }; }
        catch (error) { data = { ok: false, reason: error instanceof Error ? error.message : 'Gaussian decoding failed.' }; }
        if (!this.terminated) this.onmessage?.({ data } as MessageEvent);
      })();
    }
    terminate() { if (!this.terminated) { this.terminated = true; if (this.decoder) stats.terminated++; } }
  }
  globalThis.Worker = InThreadGaussianWorker as unknown as typeof Worker;
  return {
    stats,
    hold(): () => void { let release!: () => void; gate = new Promise(resolve => { release = resolve; }); return () => { gate = null; release(); }; },
    restore() { globalThis.Worker = saved; },
  };
}
