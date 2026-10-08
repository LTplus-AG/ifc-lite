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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wasm = vi.hoisted(() => {
  const pending: Array<() => void> = [];
  return {
    init: vi.fn(() => new Promise<void>((resolve) => { pending.push(resolve); })),
    finish: () => { for (const resolve of pending.splice(0)) resolve(); },
    IfcAPI: class { free() {} },
  };
});

vi.mock('@ifc-lite/wasm', () => ({ default: wasm.init, IfcAPI: wasm.IfcAPI }));

const g = globalThis as Record<string, unknown>;

beforeEach(() => {
  vi.resetModules();
  wasm.init.mockClear();
  // The browser path (Node reads the binary from disk instead).
  g.window = {};
});

afterEach(() => {
  delete g.window;
});

describe('IfcLiteBridge main-thread init (#7036)', () => {
  it('instantiates the engine once when two inits overlap', async () => {
    const { IfcLiteBridge } = await import('./ifc-lite-bridge.js');
    const a = new IfcLiteBridge();
    const b = new IfcLiteBridge();
    const both = Promise.all([a.init(), b.init()]);
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalled());
    wasm.finish();
    await both;
    expect(wasm.init).toHaveBeenCalledTimes(1);
    expect(a.isInitialized() && b.isInitialized()).toBe(true);
  });

  it('retries after a failed init instead of replaying the failure', async () => {
    const { IfcLiteBridge } = await import('./ifc-lite-bridge.js');
    wasm.init.mockImplementationOnce(() => Promise.reject(new Error('CompileError: invalid wasm')));
    await expect(new IfcLiteBridge().init()).rejects.toThrow(/invalid wasm/);
    const retry = new IfcLiteBridge().init();
    await vi.waitFor(() => expect(wasm.init).toHaveBeenCalledTimes(2));
    wasm.finish();
    await retry;
  });
});
