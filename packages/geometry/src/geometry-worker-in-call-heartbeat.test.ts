/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The worker side of the in-call geometry heartbeat: whichever way the WASM
 * module is initialised (the host's shared compiled module, or the worker's own
 * fetch), the progress callback the kernel invokes from INSIDE a batch call
 * must reach the host as a liveness message, and must stay silent outside one.
 * Drives the real worker message handler with the wasm mocked; the Rust side
 * is pinned by the wasm contract test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const state: { callback: (() => void) | null } = { callback: null };
  const setGeometryProgressCallback = vi.fn((callback?: (() => void) | null) => {
    state.callback = callback ?? null;
  });
  const processGeometryBatch = vi.fn(() => {
    // A long element: the kernel reports progress twice inside the call.
    state.callback?.();
    state.callback?.();
    return { length: 0, geometryHashCount: 0, takeMesh: () => undefined, free: () => {} };
  });
  class MockIfcAPI {
    processGeometryBatch = processGeometryBatch;
    free(): void {}
  }
  return { init: vi.fn(async () => undefined), initSync: vi.fn(), MockIfcAPI, state, setGeometryProgressCallback, processGeometryBatch };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMocks.init,
  initSync: wasmMocks.initSync,
  setGeometryProgressCallback: wasmMocks.setGeometryProgressCallback,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

type Posted = { type?: string; seq?: number; processedJobs?: number; totalJobs?: number };
const posted: Posted[] = [];
let originalSelf: unknown;
let originalPostMessage: unknown;
let importCounter = 0;

async function send(data: unknown): Promise<void> {
  (self as unknown as Worker).onmessage!({ data } as MessageEvent);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(async () => {
  posted.length = 0;
  wasmMocks.state.callback = null;
  wasmMocks.setGeometryProgressCallback.mockClear();
  wasmMocks.processGeometryBatch.mockClear();
  const g = globalThis as Record<string, unknown>;
  originalSelf = g.self;
  originalPostMessage = g.postMessage;
  g.self = globalThis;
  g.postMessage = (msg: Posted) => posted.push(msg);
  await import('./geometry.worker.js?t=' + ++importCounter);
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  if (originalSelf === undefined) delete g.self; else g.self = originalSelf;
  if (originalPostMessage === undefined) delete g.postMessage; else g.postMessage = originalPostMessage;
});

const emptyU32 = () => new Uint32Array(0);
const isInCallHeartbeat = (m: Posted) =>
  m.type === 'progress' && m.seq === undefined && m.processedJobs === 0 && m.totalJobs === 0;

async function streamOneChunk(init: Record<string, unknown>): Promise<void> {
  await send({ type: 'init', ...init });
  await send({
    type: 'stream-start',
    sharedBuffer: new SharedArrayBuffer(8),
    unitScale: 1, rtcX: 0, rtcY: 0, rtcZ: 0, needsShift: false,
    voidKeys: emptyU32(), voidCounts: emptyU32(), voidValues: emptyU32(),
    styleIds: emptyU32(), styleColors: new Uint8Array(0),
  });
  await send({ type: 'stream-chunk', jobsFlat: new Uint32Array([1, 0, 1]), seq: 7 });
}

describe('geometry.worker.ts in-call heartbeat', () => {
  for (const [label, init] of [
    ['the shared compiled module (initSync)', { wasmModule: {} }],
    ['the worker-local fetch (init)', {}],
  ] as const) {
    it(`forwards progress from inside a batch call when initialised from ${label}`, async () => {
      await streamOneChunk(init);
      expect(posted.filter((m) => m.type === 'error')).toEqual([]);
      expect(wasmMocks.processGeometryBatch).toHaveBeenCalledTimes(1);
      const callStart = posted.findIndex((m) => m.type === 'progress' && m.seq === 7);
      const sliceDone = posted.findIndex((m) => m.type === 'slice-done');
      const beats = posted
        .map((m, i) => [m, i] as const)
        .filter(([m]) => isInCallHeartbeat(m))
        .map(([, i]) => i);
      expect(callStart).toBeGreaterThanOrEqual(0);
      expect(sliceDone).toBeGreaterThan(callStart);
      expect(beats).toHaveLength(2);
      expect(beats.every((i) => i > callStart && i < sliceDone)).toBe(true);

      // Outside a batch call (pre-pass, style resolution, idle) it stays silent.
      const before = posted.length;
      wasmMocks.state.callback?.();
      expect(posted.length).toBe(before);
    });
  }
});
