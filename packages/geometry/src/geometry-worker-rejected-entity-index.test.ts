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
  class MockIfcAPI {
    setEntityIndex = setEntityIndex;
    free(): void {}
  }
  return { init: vi.fn(async () => undefined), initSync: vi.fn(), MockIfcAPI, setEntityIndex };
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
  });
});
