/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const parseSymbolicRepresentations = vi.fn();
  const setMergeLayers = vi.fn();
  const free = vi.fn();

  class MockIfcAPI {
    parseSymbolicRepresentations(content: string) {
      return parseSymbolicRepresentations(content);
    }
    setMergeLayers(enabled: boolean) {
      return setMergeLayers(enabled);
    }
    free() {
      return free();
    }
  }

  return {
    init: vi.fn(async () => undefined),
    parseSymbolicRepresentations,
    setMergeLayers,
    free,
    MockIfcAPI,
  };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMocks.init,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

import { IfcLiteBridge } from './ifc-lite-bridge.js';

describe('IfcLiteBridge', () => {
  beforeEach(() => {
    wasmMocks.init.mockClear();
    wasmMocks.parseSymbolicRepresentations.mockReset();
    wasmMocks.setMergeLayers.mockReset();
    wasmMocks.free.mockReset();
  });

  it('forwards setMergeLayers to the WASM API after init', async () => {
    const bridge = new IfcLiteBridge();
    await bridge.init();

    bridge.setMergeLayers(true);
    expect(bridge.getMergeLayers()).toBe(true);
    expect(wasmMocks.setMergeLayers).toHaveBeenCalledWith(true);

    bridge.setMergeLayers(false);
    expect(bridge.getMergeLayers()).toBe(false);
    expect(wasmMocks.setMergeLayers).toHaveBeenLastCalledWith(false);
  });

  it('caches setMergeLayers calls made before init and replays on init', async () => {
    const bridge = new IfcLiteBridge();
    bridge.setMergeLayers(true);
    expect(wasmMocks.setMergeLayers).not.toHaveBeenCalled();
    expect(bridge.getMergeLayers()).toBe(true);

    await bridge.init();
    expect(wasmMocks.setMergeLayers).toHaveBeenCalledWith(true);
  });

  it('dispose() frees the underlying WASM handle deterministically and is idempotent', async () => {
    const bridge = new IfcLiteBridge();
    await bridge.init();
    expect(bridge.isInitialized()).toBe(true);

    bridge.dispose();
    expect(wasmMocks.free).toHaveBeenCalledTimes(1);
    expect(bridge.isInitialized()).toBe(false);

    // A second dispose() must not double-free the same wasm-bindgen
    // pointer: the handle was already nulled by the first call, so this
    // is a no-op (free() call count stays at 1).
    bridge.dispose();
    expect(wasmMocks.free).toHaveBeenCalledTimes(1);

    // getApi() throws "not initialized" once disposed — proves the handle
    // is really gone, not just cosmetically marked disposed.
    expect(() => bridge.getApi()).toThrow('IFC-Lite not initialized. Call init() first.');
  });

  it('[Symbol.dispose]() frees the WASM handle at `using` scope exit', async () => {
    let bridge: IfcLiteBridge;
    {
      using scoped = new IfcLiteBridge();
      bridge = scoped;
      await scoped.init();
      expect(wasmMocks.free).not.toHaveBeenCalled();
    }
    expect(wasmMocks.free).toHaveBeenCalledTimes(1);
    expect(bridge.isInitialized()).toBe(false);
  });

  it('dispose() before init() is a no-op (no handle to free yet)', () => {
    const bridge = new IfcLiteBridge();
    expect(() => bridge.dispose()).not.toThrow();
    expect(wasmMocks.free).not.toHaveBeenCalled();
  });

  // NB: this test must run LAST in the file — `fatalWasmRuntimeError` in
  // ifc-lite-bridge.ts is a module-level singleton with no reset hook, so
  // once it fires every later `init()` call in this module instance
  // (including in other `it()` blocks below it) throws immediately.
  it('blocks in-process reinitialization after a fatal wasm runtime error', async () => {
    const bridge = new IfcLiteBridge();
    await bridge.init();

    wasmMocks.parseSymbolicRepresentations.mockImplementationOnce(() => {
      throw new WebAssembly.RuntimeError('panic');
    });

    expect(() => bridge.parseSymbolicRepresentations('broken ifc')).toThrow(WebAssembly.RuntimeError);
    await expect(bridge.init()).rejects.toThrow(
      'IFC-Lite WASM cannot recover from a fatal runtime error within the same document lifetime.',
    );
    expect(wasmMocks.init).toHaveBeenCalledTimes(1);
  });
});
