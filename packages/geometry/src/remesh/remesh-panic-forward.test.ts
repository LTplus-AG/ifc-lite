/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemeshClient } from './remesh-client.js';
import { WASM_PANIC_STASH_KEY } from '../wasm-panic-forward.js';
import type { RemeshConfig } from './remesh-core.js';
import type { RemeshWorkerInbound, RemeshWorkerOutbound } from './remesh-protocol.js';

const faults = vi.hoisted(() => ({ init: false, request: true, config: false, cleanup: false, clear: false, omitLocation: false, message: 'unreachable' }));
const LOCATION = 'rust/geometry/src/example.rs:42:9';
vi.mock('@ifc-lite/wasm', () => ({
  default: async () => { if (faults.init) trap(); },
  initSync: () => { if (faults.init) trap(); },
  IfcAPI: class {
    setMergeLayers() { if (faults.config) trap(); }
    setTessellationQuality() {}
    setSkipSmallCuts() {}
    setRectParamFastPath() {}
    buildPrePassOnce() {
      if (faults.request) trap();
      return { jobs: new Uint32Array(), styleIds: new Uint32Array(), styleColors: new Uint8Array() };
    }
    clearPrePassCache() {
      if (!faults.clear) return;
      (self as unknown as Record<string, unknown>)[WASM_PANIC_STASH_KEY] = {
        location: 'clear-cache.rs:98:1', at: Date.now(),
      };
      throw new WebAssembly.RuntimeError('clear cache unreachable');
    }
    free() {
      if (!faults.cleanup) return;
      (self as unknown as Record<string, unknown>)[WASM_PANIC_STASH_KEY] = {
        location: 'cleanup.rs:99:1', at: Date.now(),
      };
      throw new WebAssembly.RuntimeError('cleanup unreachable');
    }
  },
}));

function trap(): never {
  if (!faults.omitLocation) {
    (self as unknown as Record<string, unknown>)[WASM_PANIC_STASH_KEY] = {
      location: LOCATION, at: Date.now(),
    };
  }
  throw new WebAssembly.RuntimeError(faults.message);
}

const CONFIG: RemeshConfig = {
  mergeLayers: false, tessellationQuality: null, skipSmallCuts: false, rectParamFastPath: true,
};
const mainRealm = globalThis as Record<string, unknown>;

afterEach(() => {
  delete mainRealm[WASM_PANIC_STASH_KEY];
  faults.init = false;
  faults.request = true;
  faults.config = false;
  faults.cleanup = false;
  faults.clear = false;
  faults.omitLocation = false;
  faults.message = 'unreachable';
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Run the actual worker handler against a separate realm object. Only the
 * wasm boundary is fault-injected; message construction and client routing
 * are production code. Regression diagnostic coverage for #6555. */
async function harness() {
  const sent: RemeshWorkerOutbound[] = [];
  const clientWorker = {
    onmessage: null as ((event: MessageEvent<RemeshWorkerOutbound>) => void) | null,
    terminate: vi.fn(),
    postMessage(message: RemeshWorkerInbound) {
      workerRealm.onmessage?.({ data: message } as MessageEvent<RemeshWorkerInbound>);
    },
  };
  const workerRealm = {
    onmessage: null as ((event: MessageEvent<RemeshWorkerInbound>) => void) | null,
    postMessage(message: RemeshWorkerOutbound) {
      sent.push(message);
      clientWorker.onmessage?.({ data: message } as MessageEvent<RemeshWorkerOutbound>);
    },
  };
  vi.stubGlobal('self', workerRealm);
  await import('./remesh.worker.js');
  return {
    sent, workerRealm,
    start: () => RemeshClient.create(CONFIG, {
      createWorker: () => clientWorker as unknown as Worker,
    }),
  };
}

describe('remesh panic attribution (#6555)', () => {
  it('preserves the Rust source location across an initialization trap', async () => {
    faults.init = true;
    const h = await harness();
    await expect(h.start()).rejects.toThrow('unreachable');
    expect(h.sent.at(-1)).toMatchObject({ type: 'init-error', wasmPanicLocation: LOCATION });
    expect(mainRealm[WASM_PANIC_STASH_KEY]).toMatchObject({ location: LOCATION });
    expect((h.workerRealm as Record<string, unknown>)[WASM_PANIC_STASH_KEY]).toBeUndefined();
  });

  it.each(['remesh', 'style-wire'] as const)('forwards and consumes a %s panic before rejecting', async (type) => {
    const h = await harness();
    const client = await h.start();
    try {
      const pending = type === 'style-wire'
        ? client.styleWire(new Uint8Array(8))
        : client.remesh({
          buffer: new Uint8Array(8), targets: Uint32Array.of(1),
          frame: { x: 0, y: 0, z: 0, needsShift: false },
          styleIds: new Uint32Array(), styleColors: new Uint8Array(),
        });
      await expect(pending).rejects.toThrow('unreachable');
      expect(h.sent.at(-1)).toMatchObject({ type: 'error', wasmPanicLocation: LOCATION });
      expect(mainRealm[WASM_PANIC_STASH_KEY]).toMatchObject({ location: LOCATION });
      expect((h.workerRealm as Record<string, unknown>)[WASM_PANIC_STASH_KEY]).toBeUndefined();
    } finally {
      client.dispose();
    }
  });

  it.each(['remesh', 'style-wire'] as const)('preserves the primary %s trap when cache cleanup also traps', async (type) => {
    faults.clear = true;
    faults.cleanup = true;
    const h = await harness();
    const client = await h.start();
    try {
      const pending = type === 'style-wire'
        ? client.styleWire(new Uint8Array(8))
        : client.remesh({
          buffer: new Uint8Array(8), targets: Uint32Array.of(1),
          frame: { x: 0, y: 0, z: 0, needsShift: false },
          styleIds: new Uint32Array(), styleColors: new Uint8Array(),
        });
      await expect(pending).rejects.toThrow('Re-mesh failed: unreachable');
      expect(h.sent.at(-1)).toMatchObject({ wasmPanicLocation: LOCATION });
      expect((h.workerRealm as Record<string, unknown>)[WASM_PANIC_STASH_KEY]).toBeUndefined();
    } finally {
      client.dispose();
    }
  });

  it('drains a suppressed config failure and its cleanup before a later bare trap', async () => {
    const h = await harness();
    const client = await h.start();
    try {
      faults.config = true;
      faults.cleanup = true;
      client.setConfig(CONFIG);
      for (let i = 0; i < 30; i++) await Promise.resolve();
      expect((h.workerRealm as Record<string, unknown>)[WASM_PANIC_STASH_KEY]).toBeUndefined();
      faults.config = false;
      faults.omitLocation = true;
      await expect(client.styleWire(new Uint8Array(8))).rejects.toThrow('unreachable');
      expect(mainRealm[WASM_PANIC_STASH_KEY]).toBeUndefined();
    } finally {
      client.dispose();
    }
  });

  it('reports a cache-cleanup trap when the operation itself succeeded', async () => {
    faults.request = false;
    faults.clear = true;
    const h = await harness();
    const client = await h.start();
    try {
      await expect(client.styleWire(new Uint8Array(8))).rejects.toThrow('clear cache unreachable');
      expect(h.sent.at(-1)).toMatchObject({ wasmPanicLocation: 'clear-cache.rs:98:1' });
    } finally {
      client.dispose();
    }
  });

  it('keeps the original config panic when freeing the new handle also traps', async () => {
    faults.config = true;
    faults.cleanup = true;
    const h = await harness();
    await expect(h.start()).rejects.toThrow('unreachable');
    expect(h.sent.at(-1)).toMatchObject({ type: 'init-error', wasmPanicLocation: LOCATION });
    expect((h.workerRealm as Record<string, unknown>)[WASM_PANIC_STASH_KEY]).toBeUndefined();
  });

  it('does not reuse a cleanup panic for a later bare request trap', async () => {
    faults.cleanup = true;
    const h = await harness();
    const client = await h.start();
    try {
      await expect(client.styleWire(new Uint8Array(8))).rejects.toThrow('unreachable');
      expect(h.sent.at(-1)).toMatchObject({ wasmPanicLocation: LOCATION });
      delete mainRealm[WASM_PANIC_STASH_KEY];
      faults.omitLocation = true;
      await expect(client.styleWire(new Uint8Array(8))).rejects.toThrow('unreachable');
      expect(h.sent.at(-1)?.type).toBe('error');
      expect(h.sent.at(-1)).not.toHaveProperty('wasmPanicLocation', 'cleanup.rs:99:1');
      expect(mainRealm[WASM_PANIC_STASH_KEY]).toBeUndefined();
    } finally {
      client.dispose();
    }
  });

  it('does not attribute a non-trap request error to a leftover Rust panic', async () => {
    faults.message = 'network is unreachable';
    const h = await harness();
    const client = await h.start();
    try {
      await expect(client.styleWire(new Uint8Array(8))).rejects.toThrow('network is unreachable');
      expect(mainRealm[WASM_PANIC_STASH_KEY]).toBeUndefined();
    } finally {
      client.dispose();
    }
  });
});
