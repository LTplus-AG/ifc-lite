/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Implicit-state audit P6: `IfcLiteBridge.init()` kept its lifecycle in a
 * `boolean` plus a nullable handle. Two overlapping `init()` calls on one
 * bridge each built an `IfcAPI` and the second overwrote (leaked) the first,
 * and a `dispose()` that landed while `init()` was awaiting the engine was
 * undone when `init()` resumed and marked the bridge initialized again.
 * `dispose()` is NOT terminal: `init()` -> `dispose()` -> `init()` rebuilds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wasm = vi.hoisted(() => {
  const pending: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  const free = vi.fn();
  let constructed = 0;
  class IfcAPI {
    constructor() { constructed += 1; }
    free() { free(); }
  }
  return {
    init: vi.fn(() => new Promise<void>((resolve, reject) => { pending.push({ resolve, reject }); })),
    finish: () => { for (const p of pending.splice(0)) p.resolve(); },
    finishFirst: () => { pending.shift()?.resolve(); },
    /** Settle the engine-init call at `index` (in call order) without touching the others. */
    settleAt: (index: number, error?: unknown) => {
      const p = pending.splice(index, 1)[0];
      if (!p) throw new Error(`no pending engine init at ${index}`);
      if (error === undefined) p.resolve(); else p.reject(error);
    },
    fail: (e: unknown) => { for (const p of pending.splice(0)) p.reject(e); },
    constructedCount: () => constructed,
    resetConstructed: () => { constructed = 0; },
    free,
    IfcAPI,
  };
});

vi.mock('@ifc-lite/wasm', () => ({ default: wasm.init, IfcAPI: wasm.IfcAPI }));

// Fresh modules per test: the main-thread engine init and the shared wasm
// module cache are realm singletons (#7036), as in ifc-lite-bridge-shared-init.
async function load() {
  return import('./ifc-lite-bridge.js');
}

const g = globalThis as Record<string, unknown>;

beforeEach(() => {
  // Take the browser path (shared main-thread engine init, #7036); under Node
  // the bridge would read the real binary from disk instead.
  g.window = {};
  vi.resetModules();
  // mockReset also drops an unconsumed mockImplementationOnce (vitest restores
  // the vi.fn() default), so one test cannot leak into the next.
  wasm.init.mockReset();
  wasm.free.mockReset();
  wasm.resetConstructed();
});

afterEach(() => {
  delete g.window;
});

describe('IfcLiteBridge init lifecycle (audit P6)', () => {
  it('P6: overlapping init() calls on one bridge build exactly one IfcAPI', async () => {
    const { IfcLiteBridge } = await load();
    const bridge = new IfcLiteBridge();
    const both = Promise.all([bridge.init(), bridge.init()]);
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalled());
    wasm.finish();
    await both;
    expect(wasm.constructedCount()).toBe(1);
    bridge.dispose();
    // The only handle ever built is the one dispose() frees.
    expect(wasm.free).toHaveBeenCalledTimes(1);
  });

  it('P6: dispose() during an in-flight init() is not undone when init() resumes', async () => {
    const { IfcLiteBridge } = await load();
    const bridge = new IfcLiteBridge();
    const initializing = bridge.init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalled());
    bridge.dispose();
    wasm.finish();
    await expect(initializing).rejects.toThrow(/superseded by dispose/);
    expect(bridge.isInitialized()).toBe(false);
    expect(wasm.constructedCount()).toBe(0);
    expect(() => bridge.getApi()).toThrow(/not initialized/);
  });

  it('P6: init() -> dispose() -> init() rebuilds a fresh handle (dispose is not terminal)', async () => {
    const { IfcLiteBridge } = await load();
    const bridge = new IfcLiteBridge();
    const first = bridge.init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalled());
    wasm.finish();
    await first;
    bridge.dispose();
    expect(wasm.free).toHaveBeenCalledTimes(1);
    wasm.init.mockImplementationOnce(async () => undefined);
    await expect(bridge.init()).resolves.toBeUndefined();
    expect(bridge.isInitialized()).toBe(true);
    expect(wasm.constructedCount()).toBe(2);
    bridge.dispose();
    expect(wasm.free).toHaveBeenCalledTimes(2);
  });

  it('P6: init() after a mid-init dispose() starts a fresh attempt that the stale one settling late does not drop', async () => {
    // Node path: each attempt gets its own engine-init call, so the stale
    // attempt can settle while the fresh one is still in flight.
    delete g.window;
    const { IfcLiteBridge } = await load();
    const bridge = new IfcLiteBridge();
    const stale = bridge.init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalledTimes(1));
    bridge.dispose();
    const fresh = bridge.init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalledTimes(2));
    wasm.finishFirst();
    await expect(stale).rejects.toThrow(/superseded by dispose/);
    // Settling the stale attempt must not drop the fresh one: this joins it.
    const joined = bridge.init();
    wasm.finish();
    await Promise.all([fresh, joined]);
    expect(wasm.init).toHaveBeenCalledTimes(2);
    expect(wasm.constructedCount()).toBe(1);
    expect(bridge.isInitialized()).toBe(true);
    bridge.dispose();
  });

  // Node path for the next two: each attempt gets its own engine-init call, so
  // the stale attempt can FAIL independently of the fresh one (#9500 review).
  it('P6: a stale init() failing after its replacement succeeded does not free the fresh handle', async () => {
    delete g.window;
    const { IfcLiteBridge } = await load();
    const bridge = new IfcLiteBridge();
    const stale = bridge.init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalledTimes(1));
    bridge.dispose();
    const fresh = bridge.init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalledTimes(2));
    wasm.settleAt(1);
    await fresh;
    wasm.settleAt(0, new Error('CompileError: stale engine'));
    await expect(stale).rejects.toThrow(/stale engine/);
    expect(bridge.isInitialized()).toBe(true);
    expect(wasm.free).not.toHaveBeenCalled();
    expect(() => bridge.getApi()).not.toThrow();
    bridge.dispose();
  });

  it('P6: a stale init() failing while its replacement is in flight does not supersede it', async () => {
    delete g.window;
    const { IfcLiteBridge } = await load();
    const bridge = new IfcLiteBridge();
    const stale = bridge.init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalledTimes(1));
    bridge.dispose();
    const fresh = bridge.init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalledTimes(2));
    wasm.settleAt(0, new Error('CompileError: stale engine'));
    await expect(stale).rejects.toThrow(/stale engine/);
    wasm.settleAt(0);
    await expect(fresh).resolves.toBeUndefined();
    expect(bridge.isInitialized()).toBe(true);
    expect(wasm.constructedCount()).toBe(1);
    bridge.dispose();
  });

  it('P6: dispose() whose free() throws still lets the next init() rebuild', async () => {
    const { IfcLiteBridge } = await load();
    const bridge = new IfcLiteBridge();
    const first = bridge.init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalled());
    wasm.finish();
    await first;
    wasm.free.mockImplementationOnce(() => { throw new Error('free failed'); });
    expect(() => bridge.dispose()).toThrow('free failed');
    expect(bridge.isInitialized()).toBe(false);
    wasm.init.mockImplementationOnce(async () => undefined);
    await expect(bridge.init()).resolves.toBeUndefined();
    expect(wasm.constructedCount()).toBe(2);
    bridge.dispose();
  });

  it('P6: a failed init() clears the in-flight attempt so a retry runs a fresh one', async () => {
    const { IfcLiteBridge } = await load();
    const bridge = new IfcLiteBridge();
    const failing = bridge.init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalledTimes(1));
    // A non-transport failure is not retried by initWasmWithRetry.
    wasm.fail(new Error('CompileError: invalid wasm'));
    await expect(failing).rejects.toThrow(/invalid wasm/);
    expect(bridge.isInitialized()).toBe(false);

    const retry = bridge.init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalledTimes(2));
    wasm.finish();
    await expect(retry).resolves.toBeUndefined();
    expect(bridge.isInitialized()).toBe(true);
    bridge.dispose();
  });

  it('P6: init() on an already-ready bridge resolves without building another IfcAPI', async () => {
    const { IfcLiteBridge } = await load();
    const bridge = new IfcLiteBridge();
    const first = bridge.init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalled());
    wasm.finish();
    await first;
    await bridge.init();
    expect(wasm.constructedCount()).toBe(1);
    bridge.dispose();
  });

  // index.js pulls the whole package graph through a fresh module registry.
  it('P6: GeometryProcessor.dispose() during its init() leaves no live engine handle', { timeout: 60_000 }, async () => {
    const { GeometryProcessor } = await import('./index.js');
    const processor = new GeometryProcessor();
    const initializing = processor.init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalled());
    processor.dispose();
    wasm.finish();
    await expect(initializing).rejects.toThrow(/superseded by dispose/);
    expect(wasm.constructedCount()).toBe(0);
  });

  it('P6: reset() drops a ready bridge, so the next init() builds a fresh handle', async () => {
    const { IfcLiteBridge } = await load();
    const bridge = new IfcLiteBridge();
    const first = bridge.init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalled());
    wasm.finish();
    await first;
    bridge.reset();
    expect(bridge.isInitialized()).toBe(false);
    wasm.init.mockImplementationOnce(async () => undefined);
    await bridge.init();
    expect(wasm.constructedCount()).toBe(2);
    bridge.dispose();
  });
});
