/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4614: `IfcAPI.setEntityIndex` throws for columns of unequal length, and the
 * worker replays its cached entity index onto every new IfcAPI. A rejected
 * index must reach the host once and never be replayed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const setEntityIndex = vi.fn(() => {
    throw new Error('setEntityIndex: entity index columns disagree in length');
  });
  const finalizePrepassStyles = vi.fn(() => {
    throw new Error('finalizePrepassStyles: orphan style columns disagree: 2 ids need 8 colour floats, got 4');
  });
  const setReferencedRepmaps = vi.fn();
  const setInstantiatedTypeIds = vi.fn();
  const setMappedInstancePlan = vi.fn();
  const setMaterialLayerIndex = vi.fn();
  class MockIfcAPI {
    setEntityIndex = setEntityIndex;
    finalizePrepassStyles = finalizePrepassStyles;
    setReferencedRepmaps = setReferencedRepmaps;
    setInstantiatedTypeIds = setInstantiatedTypeIds;
    setMappedInstancePlan = setMappedInstancePlan;
    setMaterialLayerIndex = setMaterialLayerIndex;
    free(): void {}
  }
  return {
    init: vi.fn(async () => undefined), initSync: vi.fn(), MockIfcAPI,
    setEntityIndex, finalizePrepassStyles, setReferencedRepmaps,
    setInstantiatedTypeIds, setMappedInstancePlan, setMaterialLayerIndex,
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
// Monotonic, not `Date.now()`: two imports in the same millisecond would
// share one module instance (same rule as geometry-worker-panic-forward.test.ts).
let importCounter = 0;

async function send(data: unknown): Promise<void> {
  (self as unknown as Worker).onmessage!({ data } as MessageEvent);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(async () => {
  posted.length = 0;
  wasmMocks.setEntityIndex.mockClear();
  wasmMocks.finalizePrepassStyles.mockClear();
  wasmMocks.setReferencedRepmaps.mockClear();
  wasmMocks.setInstantiatedTypeIds.mockClear();
  wasmMocks.setMappedInstancePlan.mockClear();
  wasmMocks.setMaterialLayerIndex.mockClear();
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

describe('geometry.worker.ts with a rejected entity index', () => {
  it('reports the rejection once and does not replay it onto a re-initialised IfcAPI', async () => {
    await send({ type: 'init' });
    const emptyU32 = new Uint32Array(0);
    const emptyF64 = new Float64Array(0);
    await send({
      type: 'set-prepass-columns',
      referencedRepmaps: new Uint32Array([41]),
      instantiatedTypeIds: new Uint32Array([42]),
      mappedInstancePlan: new Uint32Array([43]),
      mliElementIds: emptyU32,
      mliAxis: emptyU32,
      mliLayerCounts: emptyU32,
      mliDirectionSense: emptyF64,
      mliOffset: emptyF64,
      mliLayerMaterialIds: emptyU32,
      mliLayerThicknesses: emptyF64,
    });
    await send({
      type: 'set-entity-index',
      ids: new Uint32Array([1, 2]),
      starts: new Uint32Array([0]),
      lengths: new Uint32Array([1, 1]),
    });
    // A new IfcAPI replays every cached setting. The rejected index must not
    // be among them, or this init throws instead of reporting ready.
    await send({ type: 'init', wasmModule: {} });

    expect(posted.map((m) => m.type)).toEqual(['ready', 'error', 'ready']);
    expect(posted[1]?.message).toMatch(/disagree in length/);
    expect(wasmMocks.setEntityIndex).toHaveBeenCalledTimes(1);
    expect(wasmMocks.setReferencedRepmaps).toHaveBeenCalledTimes(1);
    expect(wasmMocks.setInstantiatedTypeIds).toHaveBeenCalledTimes(1);
    expect(wasmMocks.setMappedInstancePlan).toHaveBeenCalledTimes(1);
    expect(wasmMocks.setMaterialLayerIndex).toHaveBeenCalledTimes(1);
  });

  it('reports a column refusal from finalizePrepassStyles without retrying on a copy of the file', async () => {
    await send({ type: 'init' });
    const empty = new Uint32Array(0);
    await send({
      type: 'finalize-styles',
      sharedBuffer: new SharedArrayBuffer(8),
      orphanIds: new Uint32Array([1, 2]), orphanColors: new Float32Array(4),
      geomIds: empty, geomColors: new Float32Array(0),
      colourMapSpans: empty, materialDefSpans: empty, relMaterialSpans: empty,
      voidSpans: empty, fillsSpans: empty, aggregateSpans: empty,
      planeAngleToRadians: 1,
    });

    expect(posted.map((m) => m.type)).toEqual(['ready', 'error']);
    expect(posted[1]?.message).toMatch(/columns disagree/);
    // The SAB-view fallback would call it a second time with a materialised copy.
    expect(wasmMocks.finalizePrepassStyles).toHaveBeenCalledTimes(1);
  });
});
