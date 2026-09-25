/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5582: the `processGeometryBatch*` signatures carry only `styleIds` +
 * `styleColors`, so the worker must hand the streamed `styleFinishes` to its
 * IfcAPI via `setStyleFinishes` before the first batch that uses that style
 * wire, and hand a sharded prepass's merged `geomFinishes` to
 * `setPrepassGeometryFinishes` before each finalize attempt. These tests drive
 * the real worker message handler; the wasm is mocked, so they pin the
 * wiring, not the Rust side (that is `style_finishes_tests.rs`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const calls: string[] = [];
  const setStyleFinishes = vi.fn((_ids: Uint32Array, _finishes: Float32Array) => {
    calls.push('setStyleFinishes');
  });
  const processGeometryBatch = vi.fn(() => {
    calls.push('processGeometryBatch');
    return { length: 0, geometryHashCount: 0, takeMesh: () => undefined, free: () => {} };
  });
  const setPrepassGeometryFinishes = vi.fn((_ids: Uint32Array, _finishes: Float32Array) => {
    calls.push('setPrepassGeometryFinishes');
  });
  const finalizePrepassStyles = vi.fn(() => {
    calls.push('finalizePrepassStyles');
    return {};
  });
  class MockIfcAPI {
    setStyleFinishes = setStyleFinishes;
    processGeometryBatch = processGeometryBatch;
    setPrepassGeometryFinishes = setPrepassGeometryFinishes;
    finalizePrepassStyles = finalizePrepassStyles;
    free(): void {}
  }
  return {
    init: vi.fn(async () => undefined), initSync: vi.fn(), MockIfcAPI, calls,
    setStyleFinishes, processGeometryBatch, setPrepassGeometryFinishes, finalizePrepassStyles,
  };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMocks.init,
  initSync: wasmMocks.initSync,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

const posted: Array<{ type?: string; message?: string }> = [];
let originalSelf: unknown;
let originalPostMessage: unknown;
let importCounter = 0;

async function send(data: unknown): Promise<void> {
  (self as unknown as Worker).onmessage!({ data } as MessageEvent);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(async () => {
  posted.length = 0;
  wasmMocks.calls.length = 0;
  wasmMocks.setStyleFinishes.mockClear();
  wasmMocks.processGeometryBatch.mockClear();
  wasmMocks.setPrepassGeometryFinishes.mockClear();
  wasmMocks.finalizePrepassStyles.mockClear();
  const g = globalThis as Record<string, unknown>;
  originalSelf = g.self;
  originalPostMessage = g.postMessage;
  g.self = globalThis;
  g.postMessage = (msg: { type?: string; message?: string }) => posted.push(msg);
  await import('./geometry.worker.js?t=' + ++importCounter);
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  if (originalSelf === undefined) delete g.self; else g.self = originalSelf;
  if (originalPostMessage === undefined) delete g.postMessage; else g.postMessage = originalPostMessage;
});

const emptyU32 = () => new Uint32Array(0);

async function startStream(): Promise<void> {
  await send({ type: 'init' });
  await send({
    type: 'stream-start',
    sharedBuffer: new SharedArrayBuffer(8),
    unitScale: 1, rtcX: 0, rtcY: 0, rtcZ: 0, needsShift: false,
    voidKeys: emptyU32(), voidCounts: emptyU32(), voidValues: emptyU32(),
    styleIds: emptyU32(), styleColors: new Uint8Array(0),
  });
}

describe('geometry.worker.ts #5582 style finishes', () => {
  it('installs the streamed styleFinishes on its IfcAPI once, before the first batch that uses them', async () => {
    await startStream();
    const styleIds = new Uint32Array([10, 11]);
    const styleFinishes = new Float32Array([1, 0.1, NaN, 0.9]);
    await send({
      type: 'set-styles',
      styleIds, styleColors: new Uint8Array(8), styleFinishes,
      voidKeys: emptyU32(), voidCounts: emptyU32(), voidValues: emptyU32(),
    });
    await send({ type: 'stream-chunk', jobsFlat: new Uint32Array([1, 0, 1]) });
    await send({ type: 'stream-chunk', jobsFlat: new Uint32Array([2, 0, 1]) });

    expect(posted.filter((m) => m.type === 'error')).toEqual([]);
    expect(wasmMocks.setStyleFinishes).toHaveBeenCalledTimes(1);
    const [ids, finishes] = wasmMocks.setStyleFinishes.mock.calls[0];
    expect(ids).toBe(styleIds);
    expect(finishes).toBe(styleFinishes);
    // The batch must see the same style wire the finishes were installed for.
    const batchArgs = wasmMocks.processGeometryBatch.mock.calls[0] as unknown[];
    expect(batchArgs[10]).toBe(styleIds);
    expect(wasmMocks.calls).toEqual(['setStyleFinishes', 'processGeometryBatch', 'processGeometryBatch']);
  });

  it('sends nothing when the styles event carries no styleFinishes (older wasm)', async () => {
    await startStream();
    await send({
      type: 'set-styles',
      styleIds: new Uint32Array([10]), styleColors: new Uint8Array(4),
      voidKeys: emptyU32(), voidCounts: emptyU32(), voidValues: emptyU32(),
    });
    await send({ type: 'stream-chunk', jobsFlat: new Uint32Array([1, 0, 1]) });

    expect(wasmMocks.processGeometryBatch).toHaveBeenCalledTimes(1);
    expect(wasmMocks.setStyleFinishes).not.toHaveBeenCalled();
  });

  it('stashes the merged geomFinishes before finalizePrepassStyles consumes them', async () => {
    await send({ type: 'init' });
    const geomIds = new Uint32Array([10]);
    const geomFinishes = new Float32Array([1, 0.1]);
    await send({
      type: 'finalize-styles',
      sharedBuffer: new SharedArrayBuffer(8),
      orphanIds: emptyU32(), orphanColors: new Float32Array(0),
      geomIds, geomColors: new Float32Array(4), geomFinishes,
      colourMapSpans: emptyU32(), materialDefSpans: emptyU32(), relMaterialSpans: emptyU32(),
      voidSpans: emptyU32(), fillsSpans: emptyU32(), aggregateSpans: emptyU32(),
      planeAngleToRadians: 1,
    });

    expect(posted.map((m) => m.type)).toEqual(['ready', 'styles-final']);
    expect(wasmMocks.setPrepassGeometryFinishes).toHaveBeenCalledWith(geomIds, geomFinishes);
    expect(wasmMocks.calls).toEqual(['setPrepassGeometryFinishes', 'finalizePrepassStyles']);
  });
});
