/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The early device request (device-request.ts): a host that knows a renderer
 * is about to mount asks for the device first, and the next
 * `WebGPUDevice.init()` adopts it. Pinned here:
 *
 *  - init adopts the early device and requests no second one;
 *  - a device lost, or a request that failed, before the claim is replaced by
 *    init's own request, so a renderer never starts on a dead device;
 *  - a device nobody claims is destroyed after the hold;
 *  - only one early request is pending at a time, and none without WebGPU.
 *
 * Hand-stubbed `navigator.gpu`, as in device-request-fallback.test.ts.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebGPUDevice } from './device.js';
import { claimPrerequestedRendererDevice, prerequestRendererDevice } from './device-request.js';

(globalThis as Record<string, unknown>).GPUTextureUsage ??= { COPY_SRC: 0x01, RENDER_ATTACHMENT: 0x10 };

const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(async () => {
  // Never leak an early request into the next test.
  const pending = claimPrerequestedRendererDevice();
  if (pending) await pending;
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
  else delete (globalThis as { navigator?: unknown }).navigator;
});

interface FakeDevice {
  id: number;
  destroyed: boolean;
  loseNow(): void;
  lost: Promise<{ message: string; reason: string }>;
  limits: { maxTextureDimension2D: number };
  features: Set<string>;
  destroy(): void;
}

/** A GPU whose adapter numbers each device it hands out; `failNext` rejects the next requestAdapter. */
function installGpu() {
  const devices: FakeDevice[] = [];
  let adapterRequests = 0;
  const state = { failNext: false };
  const adapter = {
    info: { vendor: 'testvendor', architecture: 'testarch' },
    features: new Set<string>(),
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 29 },
    requestDevice: async () => {
      let loseNow = () => {};
      const lost = new Promise<{ message: string; reason: string }>((resolve) => { loseNow = () => resolve({ message: 'lost', reason: 'unknown' }); });
      const device: FakeDevice = {
        id: devices.length + 1, destroyed: false, loseNow, lost,
        limits: { maxTextureDimension2D: 8192 }, features: new Set(),
        destroy() { this.destroyed = true; },
      };
      devices.push(device);
      return device;
    },
  };
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      gpu: {
        requestAdapter: async () => {
          adapterRequests++;
          if (state.failNext) { state.failNext = false; throw new Error('adapter refused'); }
          return adapter;
        },
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    },
    configurable: true,
  });
  return { devices, state, adapterRequests: () => adapterRequests };
}

function makeCanvas(): HTMLCanvasElement {
  return { width: 256, height: 256, getContext: () => ({ configure: () => {} }) } as unknown as HTMLCanvasElement;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  console.warn = () => {};
  return fn().finally(() => { console.warn = warn; });
}

describe('early renderer device request', () => {
  it('init adopts the early device and requests no second one', async () => {
    const gpu = installGpu();
    assert.equal(prerequestRendererDevice(), true);
    await settle();
    assert.equal(gpu.devices.length, 1, 'the early request asked for the device before any renderer existed');

    const device = new WebGPUDevice();
    await device.init(makeCanvas());

    assert.equal(gpu.devices.length, 1, 'init asked for a second device');
    assert.equal(gpu.adapterRequests(), 1);
    assert.equal(device.isInitialized(), true);
    assert.deepEqual(device.getAdapterInfo(), { vendor: 'testvendor', architecture: 'testarch' });
    assert.equal(gpu.devices[0].destroyed, false);
  });

  it('a device lost before the claim is destroyed and replaced by a fresh one', async () => {
    const gpu = installGpu();
    prerequestRendererDevice();
    await settle();
    gpu.devices[0].loseNow();
    await settle();

    const device = new WebGPUDevice();
    await device.init(makeCanvas());

    assert.equal(gpu.devices.length, 2, 'init started on the lost early device');
    assert.equal(gpu.devices[0].destroyed, true);
    assert.equal(gpu.devices[1].destroyed, false);
  });

  it('a failed early request leaves init to request its own', async () => {
    const gpu = installGpu();
    gpu.state.failNext = true;
    await quietly(async () => {
      prerequestRendererDevice();
      await settle();
    });

    const device = new WebGPUDevice();
    await device.init(makeCanvas());

    assert.equal(gpu.adapterRequests(), 2);
    assert.equal(gpu.devices.length, 1);
    assert.equal(device.isInitialized(), true);
  });

  it('a device nobody claims is destroyed after the hold, and init then requests its own', async () => {
    const gpu = installGpu();
    prerequestRendererDevice(5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(gpu.devices.length, 1);
    assert.equal(gpu.devices[0].destroyed, true, 'an unclaimed early device outlived its hold');
    assert.equal(claimPrerequestedRendererDevice(), null);

    const device = new WebGPUDevice();
    await device.init(makeCanvas());
    assert.equal(gpu.devices.length, 2);
  });

  it('keeps one early request at a time, and makes none without WebGPU', async () => {
    installGpu();
    assert.equal(prerequestRendererDevice(), true);
    assert.equal(prerequestRendererDevice(), false, 'a second early request replaced the pending one');
    await claimPrerequestedRendererDevice();
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    assert.equal(prerequestRendererDevice(), false);
  });
});
