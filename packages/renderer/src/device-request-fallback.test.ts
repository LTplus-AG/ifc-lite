/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `WebGPUDevice.init()`'s staged `requestDevice()` degradation.
 *
 * Two asks go into the request and they are not equally important:
 * `requiredLimits` raises `maxBufferSize`/`maxStorageBufferBindingSize` to
 * what the adapter advertises, without which a large IFC's vertex buffer
 * exceeds the 256 MiB default and "nothing renders"; `requiredFeatures` asks
 * for `'timestamp-query'`, a purely opt-in diagnostic (issue #2670) that
 * does nothing at all unless a caller constructs a `GpuFrameTimingRecorder`.
 *
 * A single try/catch around both surrenders them together, so a rejection
 * caused by the diagnostic feature would silently cost a user the buffer
 * limits their model needs. These tests pin the staged behaviour in BOTH
 * directions — an adapter that accepts everything must still receive both
 * asks, and an adapter that rejects the feature must still end up with the
 * limits — plus that the bare last-resort request is still reachable.
 *
 * Same hand-stubbed `navigator.gpu` approach as device-adapter-info.test.ts.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebGPUDevice } from './device.js';

// `configureContext()` reads GPUTextureUsage.RENDER_ATTACHMENT, which node
// does not define. Same stub as device-adapter-info.test.ts.
(globalThis as Record<string, unknown>).GPUTextureUsage ??= { RENDER_ATTACHMENT: 0x10 };

const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
  if (savedNavigator) {
    Object.defineProperty(globalThis, 'navigator', savedNavigator);
  } else {
    delete (globalThis as { navigator?: unknown }).navigator;
  }
});

const ADAPTER_MAX_BUFFER = 1 << 30;
const ADAPTER_MAX_STORAGE = 1 << 29;

/** A device whose `lost` promise stays pending, carrying `grantedFeatures`. */
function makeFakeDevice(grantedFeatures: readonly string[]): unknown {
  return {
    lost: new Promise(() => { /* never settles */ }),
    limits: { maxTextureDimension2D: 8192 },
    features: new Set(grantedFeatures),
  };
}

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

function makeCanvas(): HTMLCanvasElement {
  return {
    width: 256,
    height: 256,
    getContext: () => ({ configure: () => { /* accepted */ } }),
  } as unknown as HTMLCanvasElement;
}

type Descriptor = { requiredLimits?: Record<string, number>; requiredFeatures?: string[] } | undefined;

interface RecordingAdapter {
  adapter: unknown;
  /** Every descriptor `init()` passed to requestDevice, in call order. */
  calls: Descriptor[];
}

/**
 * An adapter recording each `requestDevice()` descriptor. `decide` returns the
 * feature list to grant, or throws to reject that particular request — which
 * is how a driver's rejection of one specific ask is modelled.
 */
function makeRecordingAdapter(
  advertisedFeatures: readonly string[],
  decide: (descriptor: Descriptor) => readonly string[],
): RecordingAdapter {
  const calls: Descriptor[] = [];
  const adapter = {
    info: { vendor: 'testvendor', architecture: 'testarch' },
    features: new Set(advertisedFeatures),
    limits: {
      maxBufferSize: ADAPTER_MAX_BUFFER,
      maxStorageBufferBindingSize: ADAPTER_MAX_STORAGE,
    },
    requestDevice: async (descriptor?: Descriptor) => {
      calls.push(descriptor);
      return makeFakeDevice(decide(descriptor));
    },
  };
  return { adapter, calls };
}

/** Runs `fn` with console.warn captured, returning the lines it emitted. */
async function withCapturedWarnings(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  try {
    await fn();
  } finally {
    console.warn = realWarn;
  }
  return lines;
}

describe('WebGPUDevice requestDevice staging — an adapter that accepts everything', () => {
  it('asks for the raised buffer limits AND the timestamp-query feature in one request', async () => {
    const { adapter, calls } = makeRecordingAdapter(['timestamp-query'], (d) => d?.requiredFeatures ?? []);
    installNavigator(adapter);

    const device = new WebGPUDevice();
    await device.init(makeCanvas());

    assert.equal(calls.length, 1, 'a fully-accepted request must not be retried');
    // Both asks, together: dropping either on the happy path would be the
    // regression this staging exists to make impossible.
    assert.deepEqual(calls[0]?.requiredLimits, {
      maxBufferSize: ADAPTER_MAX_BUFFER,
      maxStorageBufferBindingSize: ADAPTER_MAX_STORAGE,
    });
    assert.deepEqual(calls[0]?.requiredFeatures, ['timestamp-query']);
    assert.equal(device.hasTimestampQueryFeature(), true, 'the granted feature must be reported');
  });

  it('does not request timestamp-query at all when the adapter does not advertise it', async () => {
    // Asking for a feature the adapter lacks makes requestDevice() reject
    // outright — so the feature must never appear in the request.
    const { adapter, calls } = makeRecordingAdapter([], (d) => d?.requiredFeatures ?? []);
    installNavigator(adapter);

    const device = new WebGPUDevice();
    await device.init(makeCanvas());

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.requiredFeatures, [], 'an unadvertised feature must not be requested');
    assert.equal(device.hasTimestampQueryFeature(), false);
    // The limits are still asked for — the feature's absence must not cost them.
    assert.equal(calls[0]?.requiredLimits?.maxBufferSize, ADAPTER_MAX_BUFFER);
  });
});

describe('WebGPUDevice requestDevice staging — an adapter that rejects the feature', () => {
  it('retries with the limits ALONE and keeps them, rather than dropping to a bare device', async () => {
    // The defect this pins: a driver that advertises 'timestamp-query' but
    // rejects a device request carrying it. Surrendering both asks at once
    // would give this user a 256 MiB-capped device — no render for a large
    // model — in exchange for a diagnostic they never opted into.
    const { adapter, calls } = makeRecordingAdapter(['timestamp-query'], (d) => {
      if ((d?.requiredFeatures?.length ?? 0) > 0) throw new Error('feature rejected by driver');
      return [];
    });
    installNavigator(adapter);

    const device = new WebGPUDevice();
    const warnings = await withCapturedWarnings(() => device.init(makeCanvas()));

    assert.equal(device.isInitialized(), true, 'init must still succeed');
    assert.equal(calls.length, 2, 'exactly one retry: full request, then limits-only');
    // The retry must carry the limits and NOT be a bare request.
    assert.deepEqual(calls[1]?.requiredLimits, {
      maxBufferSize: ADAPTER_MAX_BUFFER,
      maxStorageBufferBindingSize: ADAPTER_MAX_STORAGE,
    });
    assert.equal(
      calls[1]?.requiredFeatures,
      undefined,
      'the retry must drop the optional feature, not carry it again',
    );
    assert.equal(device.hasTimestampQueryFeature(), false, 'no feature was granted on the retry');
    assert.ok(
      warnings.some((w) => w.includes('requiredFeatures')),
      'the dropped feature must be logged, not silently swallowed',
    );
    assert.ok(
      !warnings.some((w) => w.includes('maxBufferSize')),
      'the limits survived, so the limits-lost warning must NOT be emitted',
    );
  });
});

describe('WebGPUDevice requestDevice staging — the bare last-resort request', () => {
  it('is still reached when even the limits-only request is rejected', async () => {
    // The pre-existing reason this fallback exists: drivers that reject
    // requiredLimits they nominally advertise. Splitting the fallback must
    // not make the bare request unreachable.
    const { adapter, calls } = makeRecordingAdapter(['timestamp-query'], (d) => {
      if (d !== undefined) throw new Error('any descriptor rejected by driver');
      return [];
    });
    installNavigator(adapter);

    const device = new WebGPUDevice();
    const warnings = await withCapturedWarnings(() => device.init(makeCanvas()));

    assert.equal(device.isInitialized(), true, 'init must still succeed on a default device');
    assert.equal(calls.length, 3, 'full request, limits-only retry, then bare');
    assert.equal(calls[2], undefined, 'the last resort must be a bare requestDevice() with no descriptor');
    assert.ok(
      warnings.some((w) => w.includes('maxBufferSize')),
      'losing the raised limits is the damaging degradation and must be logged',
    );
  });

  it('skips the limits-only retry when no feature was requested — the pre-feature behaviour', async () => {
    // With requiredFeatures empty, a limits-only retry would be byte-identical
    // to the request that just failed. This adapter advertises no feature, so
    // a rejection must go straight to the bare request: two calls, not three.
    const { adapter, calls } = makeRecordingAdapter([], (d) => {
      if (d !== undefined) throw new Error('limits rejected by driver');
      return [];
    });
    installNavigator(adapter);

    const device = new WebGPUDevice();
    await withCapturedWarnings(() => device.init(makeCanvas()));

    assert.equal(device.isInitialized(), true);
    assert.equal(calls.length, 2, 'no pointless identical retry when no feature was asked for');
    assert.equal(calls[1], undefined, 'the second call is the bare last resort');
  });
});

describe('WebGPUDevice.hasTimestampQueryFeature', () => {
  it('reports what the DEVICE granted, not what the adapter advertised', async () => {
    // An adapter can advertise the feature while the granted device does not
    // carry it (the limits-only retry, or a driver granting less than asked).
    // The getter must reflect the device, or a caller would create a query set
    // the device cannot support.
    const { adapter } = makeRecordingAdapter(['timestamp-query'], () => []);
    installNavigator(adapter);

    const device = new WebGPUDevice();
    await device.init(makeCanvas());

    assert.equal(
      device.hasTimestampQueryFeature(),
      false,
      'an advertised-but-not-granted feature must read as absent',
    );
  });

  it('is false before init() has run', async () => {
    assert.equal(new WebGPUDevice().hasTimestampQueryFeature(), false);
  });
});
