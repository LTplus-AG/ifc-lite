/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The main-thread engine init is one shared promise (#7036). A host may start
 * it when a load is requested, while the load's own `IfcLiteBridge.init()`
 * follows; wasm-bindgen's `init` only checks "already initialized" before its
 * first await, so two overlapping calls would both instantiate the engine and
 * the later instance would replace the one earlier handles point into.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const wasm = vi.hoisted(() => {
  // Engine-init calls are tagged with the epoch of the test that made them; a
  // test settles only its own, so one that timed out and resumed late cannot
  // settle the next test's.
  let pending: Array<{ epoch: number; resolve: () => void }> = [];
  let epoch = 0;
  return {
    init: vi.fn(() => new Promise<void>((resolve) => { pending.push({ epoch, resolve }); })),
    nextEpoch: () => { epoch += 1; pending = []; },
    session: () => {
      const owner = epoch;
      return {
        finish: () => {
          const mine = pending.filter((p) => p.epoch === owner);
          pending = pending.filter((p) => p.epoch !== owner);
          for (const p of mine) p.resolve();
        },
      };
    },
    IfcAPI: class { free() {} },
  };
});

vi.mock('@ifc-lite/wasm', () => ({ ENGINE_BINARY_URL: null, default: wasm.init, IfcAPI: wasm.IfcAPI }));

const g = globalThis as Record<string, unknown>;

// Transform the bridge's module graph once, outside any test's 5 s budget:
// each test re-imports it after vi.resetModules(), and a cold first import
// under full-suite load used to time out the first test.
beforeAll(async () => {
  g.window = {};
  await import('./ifc-lite-bridge.js');
  delete g.window;
}, 60_000);

beforeEach(() => {
  vi.resetModules();
  wasm.nextEpoch();
  wasm.init.mockClear();
  // The browser path (Node reads the binary from disk instead).
  g.window = {};
});

afterEach(() => {
  delete g.window;
});

describe('IfcLiteBridge main-thread init (#7036)', () => {
  it('instantiates the engine once when two inits overlap', async () => {
    const engine = wasm.session();
    const { IfcLiteBridge } = await import('./ifc-lite-bridge.js');
    const a = new IfcLiteBridge();
    const b = new IfcLiteBridge();
    const both = Promise.all([a.init(), b.init()]);
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalled());
    engine.finish();
    await both;
    expect(wasm.init).toHaveBeenCalledTimes(1);
    expect(a.isInitialized() && b.isInitialized()).toBe(true);
  });

  it('retries after a failed init instead of replaying the failure', async () => {
    const engine = wasm.session();
    const { IfcLiteBridge } = await import('./ifc-lite-bridge.js');
    wasm.init.mockImplementationOnce(() => Promise.reject(new Error('CompileError: invalid wasm')));
    await expect(new IfcLiteBridge().init()).rejects.toThrow(/invalid wasm/);
    const retry = new IfcLiteBridge().init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalledTimes(2));
    engine.finish();
    await retry;
  });
});
