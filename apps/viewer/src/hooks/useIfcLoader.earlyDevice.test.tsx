/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * On a fresh page the viewport mounts with a load's own interface reset, and
 * its renderer used to ask for a WebGPU device only then: 110-150 ms of reset
 * sat in front of a 160-370 ms device request on every first open (Holter,
 * BWK and advanced_model snapshot reopens, pre-pixel lane itemisation
 * 2026-11-12). `loadFile` now asks for the device at the pick, before the
 * reset, and the renderer that mounts adopts it (device-request.ts).
 *
 * Driven through the real hook with a hand-stubbed `navigator.gpu`:
 *  - with no renderer mounted, the device is requested before the reset
 *    starts the load, and a renderer initialised afterwards adopts exactly
 *    that device instead of requesting another;
 *  - with a renderer already mounted, nothing is requested early.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WebGPUDevice, type Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { useIfcLoader } from './useIfcLoader.js';
import { clearGlobalRefs, setGlobalRendererRef } from './useBCF.js';

(globalThis as Record<string, unknown>).GPUTextureUsage ??= { COPY_SRC: 0x01, RENDER_ATTACHMENT: 0x10 };

interface AdapterCall { loading: boolean; models: number }

function installGpu() {
  const adapterCalls: AdapterCall[] = [];
  const devices: object[] = [];
  const adapter = {
    features: new Set<string>(),
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 29 },
    requestDevice: async () => {
      const device = { lost: new Promise(() => {}), limits: { maxTextureDimension2D: 8192 }, features: new Set(), destroy() {} };
      devices.push(device);
      return device;
    },
  };
  Object.defineProperty(globalThis.navigator, 'gpu', {
    configurable: true,
    value: {
      requestAdapter: async () => {
        const state = useViewerStore.getState();
        adapterCalls.push({ loading: state.loading, models: state.models.size });
        return adapter;
      },
      getPreferredCanvasFormat: () => 'bgra8unorm',
    },
  });
  return { adapterCalls, devices };
}

const fakeCanvas = () => ({ width: 64, height: 64, getContext: () => ({ configure: () => {} }) }) as unknown as HTMLCanvasElement;

let hookApi: ReturnType<typeof useIfcLoader> | null = null;
function Probe(): null {
  hookApi = useIfcLoader();
  return null;
}
let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(async () => {
  useViewerStore.getState().resetViewerState();
  useViewerStore.getState().clearAllModels();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Probe />); });
});

afterEach(async () => {
  delete (globalThis.navigator as { gpu?: unknown }).gpu;
  clearGlobalRefs();
  const current = root;
  root = null;
  if (current) await act(async () => current.unmount());
  container?.remove();
});

/** A load that ends early (an unknown format) is enough: the request happens at the pick. */
const someFile = () => new File([new Uint8Array(64)], 'not-a-model.bin');

describe('useIfcLoader — the renderer device is requested at the pick (pre-pixel lane)', () => {
  it('asks before the reset when no renderer is mounted, and the mounting renderer adopts that device', async () => {
    const gpu = installGpu();
    await act(async () => { await hookApi!.loadFile(someFile()).catch(() => {}); });

    assert.equal(gpu.adapterCalls.length, 1, 'no early device request was made');
    assert.deepEqual(gpu.adapterCalls[0], { loading: false, models: 0 }, 'the request came after the reset instead of before it');
    assert.equal(gpu.devices.length, 1);

    const device = new WebGPUDevice();
    await device.init(fakeCanvas());
    assert.equal(gpu.adapterCalls.length, 1, 'the renderer requested its own adapter instead of adopting the early one');
    assert.equal(gpu.devices.length, 1, 'the renderer requested a second device');
    assert.equal(device.getDevice() !== null, true);
  });

  it('asks for nothing early when a renderer is already mounted', async () => {
    const gpu = installGpu();
    const ref = createRef<Renderer | null>() as { current: Renderer | null };
    ref.current = {} as Renderer;
    setGlobalRendererRef(ref);
    await act(async () => { await hookApi!.loadFile(someFile()).catch(() => {}); });
    assert.equal(gpu.adapterCalls.length, 0);
  });
});
