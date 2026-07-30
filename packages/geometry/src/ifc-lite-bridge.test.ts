/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const wasmMocks = vi.hoisted(() => {
  const parseSymbolicRepresentations = vi.fn();
  const setMergeLayers = vi.fn();
  const free = vi.fn();
  const exportGlb = vi.fn();

  class MockIfcAPI {
    parseSymbolicRepresentations(content: string) {
      return parseSymbolicRepresentations(content);
    }
    setMergeLayers(enabled: boolean) {
      return setMergeLayers(enabled);
    }
    exportGlb(...args: unknown[]) {
      return exportGlb(...args);
    }
    free() {
      return free();
    }
  }

  return {
    init: vi.fn(async () => undefined),
    parseSymbolicRepresentations,
    setMergeLayers,
    exportGlb,
    free,
    MockIfcAPI,
  };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasmMocks.init,
  IfcAPI: wasmMocks.MockIfcAPI,
}));

import { IfcLiteBridge } from './ifc-lite-bridge.js';
import {
  isWasmRuntimeTrap,
  isWasmRuntimeUnrecoverableError,
  WASM_RUNTIME_UNRECOVERABLE_EVENT,
} from './wasm-runtime-trap.js';

describe('IfcLiteBridge', () => {
  beforeEach(() => {
    wasmMocks.init.mockClear();
    wasmMocks.parseSymbolicRepresentations.mockReset();
    wasmMocks.setMergeLayers.mockReset();
    wasmMocks.exportGlb.mockReset();
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

  // ── #1898: a wasm trap must not brick the whole document ────────────────
  //
  // Production sequence (PostHog 019fa277): a GLB export trapped the engine,
  // the bridge recorded the trap in a MODULE-GLOBAL singleton, and every later
  // `init()` in the realm — including the next model load, the grid/drawing
  // meshers and every other exporter, all of which construct their own
  // `IfcLiteBridge` on the main thread — threw the stored guard Error. A wasm
  // trap can damage at most the engine instance that took it; the caches it
  // can wedge all live on the `IfcAPI` handle, which the trap path drops.

  it('a trap in one bridge does not block init() of another bridge (#1898)', async () => {
    const trapped = new IfcLiteBridge();
    await trapped.init();

    wasmMocks.exportGlb.mockImplementationOnce(() => {
      throw new WebAssembly.RuntimeError('unreachable');
    });
    expect(() => trapped.exportGlb(new Uint8Array([1, 2, 3]))).toThrow(WebAssembly.RuntimeError);

    // An unrelated consumer (model load, grid mesher, another exporter) must
    // still be able to stand up its own engine in the same document.
    const fresh = new IfcLiteBridge();
    await expect(fresh.init()).resolves.toBeUndefined();
    expect(fresh.isInitialized()).toBe(true);
    expect(() => fresh.getApi()).not.toThrow();
  });

  it('the bridge that trapped recovers on the next init() with a fresh IfcAPI (#1898)', async () => {
    const bridge = new IfcLiteBridge();
    await bridge.init();
    const before = bridge.getApi();

    wasmMocks.exportGlb.mockImplementationOnce(() => {
      throw new WebAssembly.RuntimeError('unreachable');
    });
    expect(() => bridge.exportGlb(new Uint8Array([1]))).toThrow(WebAssembly.RuntimeError);
    // The trap dropped the handle, so the bridge is no longer usable as-is …
    expect(bridge.isInitialized()).toBe(false);

    // … but re-initializing it rebuilds the engine instead of throwing.
    await expect(bridge.init()).resolves.toBeUndefined();
    expect(bridge.getApi()).not.toBe(before);
  });

  it('frees the WASM handle when an operation traps, instead of leaking it (#1898)', async () => {
    const bridge = new IfcLiteBridge();
    await bridge.init();

    wasmMocks.exportGlb.mockImplementationOnce(() => {
      throw new WebAssembly.RuntimeError('unreachable');
    });
    expect(() => bridge.exportGlb(new Uint8Array([1]))).toThrow(WebAssembly.RuntimeError);

    // Exactly once: the trap path frees, and the caller's `finally { dispose() }`
    // must not double-free the same wasm-bindgen pointer.
    expect(wasmMocks.free).toHaveBeenCalledTimes(1);
    bridge.dispose();
    expect(wasmMocks.free).toHaveBeenCalledTimes(1);
  });

  it('propagates the ORIGINAL trap from an operation, not a stored guard error (#1898)', async () => {
    const bridge = new IfcLiteBridge();
    await bridge.init();

    const trap = new WebAssembly.RuntimeError('unreachable');
    wasmMocks.exportGlb.mockImplementationOnce(() => {
      throw trap;
    });
    // The reported PostHog Error was a module-global object constructed at the
    // trap site and rethrown much later from an unrelated call, which is why
    // its stack pointed at `exportGlb` while its capture context said
    // `ifc_model_load`. Callers must get the real trap.
    let caught: unknown;
    try {
      bridge.exportGlb(new Uint8Array([1]));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(trap);
    expect(isWasmRuntimeTrap(caught)).toBe(true);
  });

  it('a trap during init() is reported as unrecoverable, with the trap as cause (#1898)', async () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    wasmMocks.init.mockImplementationOnce(async () => {
      throw trap;
    });

    // The dispatcher is feature-detected (`globalThis.dispatchEvent` +
    // `CustomEvent`), so stub it rather than relying on a DOM: these tests run
    // under the node environment, exactly like the CLI/MCP hosts where the
    // library must stay silent.
    const events: CustomEvent[] = [];
    const g = globalThis as unknown as { dispatchEvent?: (e: Event) => boolean };
    const previousDispatch = g.dispatchEvent;
    g.dispatchEvent = (e: Event) => {
      events.push(e as CustomEvent);
      return true;
    };

    const bridge = new IfcLiteBridge();
    let caught: unknown;
    try {
      await bridge.init();
    } catch (err) {
      caught = err;
    } finally {
      if (previousDispatch) g.dispatchEvent = previousDispatch;
      else delete g.dispatchEvent;
    }

    // Freshly constructed (its stack is the real throw site), typed, and it
    // carries the underlying trap for triage instead of discarding it.
    expect(isWasmRuntimeUnrecoverableError(caught)).toBe(true);
    expect((caught as Error).cause).toBe(trap);
    expect((caught as Error).message).toContain('unreachable');
    // …and the host is told, so it can offer a reload rather than fail silently.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(WASM_RUNTIME_UNRECOVERABLE_EVENT);
    expect(events[0].detail.message).toContain('unreachable');
  });
});
