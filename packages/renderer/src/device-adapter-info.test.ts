/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The adapter-identity snapshot for device-loss telemetry (issue #2624).
 *
 * The #2624 field report - "GPU device lost (unknown): A valid external
 * Instance reference no longer exists." - arrived with no way to tell WHAT GPU
 * died. `WebGPUDevice.init()` now snapshots `GPUAdapterInfo.vendor` and
 * `.architecture` so the loss report can carry them. These tests pin the two
 * properties that make the snapshot safe to read at loss time:
 *
 *  - it is a defensive COPY taken at init, never the live GPUAdapterInfo, so
 *    a browser mutating (or invalidating) its info object after a loss cannot
 *    change what we report;
 *  - the read is fully defensive: `adapter.info` shipped only in
 *    Chrome/Edge 128 and Safari 26, so a runtime without it - including one
 *    whose getter THROWS - must still complete `init()`, with the snapshot
 *    null.
 *
 * They drive the real `init()` under node against a hand-stubbed
 * `navigator.gpu`, the same by-hand GPU-stub approach as this package's other
 * lifecycle tests (renderer-init-reentry.test.ts stubs `GPUTextureUsage` the
 * same way).
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebGPUDevice } from './device.js';

// `configureContext()` reads GPUTextureUsage.RENDER_ATTACHMENT, which node
// does not define. Same stub as renderer-init-reentry.test.ts.
(globalThis as Record<string, unknown>).GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10 };

const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
  if (savedNavigator) {
    Object.defineProperty(globalThis, 'navigator', savedNavigator);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
});

/** A device whose `lost` promise stays pending - no loss during these tests. */
function makeFakeDevice(): unknown {
  return {
    lost: new Promise(() => { /* never settles */ }),
    limits: { maxTextureDimension2D: 8192 },
  };
}

/** Install a `navigator.gpu` that serves `adapter`, replacing node's navigator. */
function installNavigator(adapter: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      gpu: {
        requestAdapter: async () => adapter,
        getPreferredCanvasFormat: () => 'bgra8unorm',
      },
    },
    configurable: true,
  });
}

/** The minimum canvas surface `WebGPUDevice.init()` reads. */
function makeCanvas(): HTMLCanvasElement {
  return {
    width: 256,
    height: 256,
    getContext: () => ({ configure: () => { /* accepted */ } }),
  } as unknown as HTMLCanvasElement;
}

/** An adapter serving `info`, with the limits/requestDevice init also reads. */
function makeAdapter(info: unknown): unknown {
  return {
    info,
    limits: { maxBufferSize: 1 << 20, maxStorageBufferBindingSize: 1 << 20 },
    requestDevice: async () => makeFakeDevice(),
  };
}

describe('WebGPUDevice adapter-info snapshot (#2624)', () => {
  it('copies vendor/architecture at init - mutating the live info later changes nothing', async () => {
    const liveInfo = {
      vendor: 'testvendor',
      architecture: 'testarch',
      description: 'Free Text GPU 9000',
      device: '0x1234',
    };
    installNavigator(makeAdapter(liveInfo));

    const device = new WebGPUDevice();
    await device.init(makeCanvas());

    // The browser owns `liveInfo`; after a loss it could be anything. A
    // snapshot that retained the reference would report whatever it says NOW.
    liveInfo.vendor = 'mutated-after-init';
    liveInfo.architecture = 'mutated-after-init';

    const snapshot = device.getAdapterInfo();
    assert.ok(snapshot, 'a served adapter.info must produce a snapshot');
    assert.equal(snapshot.vendor, 'testvendor', 'must be the init-time copy, not the live reference');
    assert.equal(snapshot.architecture, 'testarch');

    // The deliberate exclusions (#2624): `description` is fingerprint-adjacent
    // free text whose natural key the analytics scrubber deletes, and `device`
    // is blank in default Chrome. Neither may be captured into the snapshot.
    const keys = Object.keys(snapshot);
    assert.ok(!keys.includes('description'), 'description must not be captured at all');
    assert.ok(!keys.includes('device'), 'device must not be captured at all');
  });

  it('survives an adapter whose info getter throws: init resolves, snapshot null', async () => {
    const adapter = {
      limits: { maxBufferSize: 1 << 20, maxStorageBufferBindingSize: 1 << 20 },
      requestDevice: async () => makeFakeDevice(),
      get info(): never {
        throw new Error('no adapter info on this runtime');
      },
    };
    installNavigator(adapter);

    const device = new WebGPUDevice();
    await device.init(makeCanvas());
    assert.equal(device.isInitialized(), true, 'a throwing info getter must not break init');
    assert.equal(device.getAdapterInfo(), null, 'no usable info means a null snapshot, not a throw');
  });

  it('drops non-string fields instead of forwarding them', async () => {
    // A hostile/odd runtime could serve numbers or objects; the snapshot is
    // typed as strings and must stay that way per-field, not all-or-nothing.
    installNavigator(makeAdapter({ vendor: 42, architecture: 'testarch' }));

    const device = new WebGPUDevice();
    await device.init(makeCanvas());
    const snapshot = device.getAdapterInfo();
    assert.ok(snapshot);
    assert.equal(snapshot.vendor, undefined, 'a non-string vendor is omitted');
    assert.equal(snapshot.architecture, 'testarch', 'while the valid field survives');
  });
});
