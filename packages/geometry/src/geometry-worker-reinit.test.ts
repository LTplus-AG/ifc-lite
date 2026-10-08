/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A prewarmed worker (#7036) receives `init` twice: once when it is spawned
 * ahead of the load, and again from the load that leases it (with that load's
 * own toggles after it). The second init must free the first IfcAPI handle,
 * not leak it in the worker's never-shrinking wasm heap, and the new handle
 * must carry the settings replayed onto it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const wasm = vi.hoisted(() => {
  const created: Array<{ freed: boolean; mergeLayers?: boolean }> = [];
  class MockIfcAPI {
    state: { freed: boolean; mergeLayers?: boolean } = { freed: false };
    constructor() { created.push(this.state); }
    setMergeLayers(on: boolean) { this.state.mergeLayers = on; }
    free() { this.state.freed = true; }
  }
  return { created, MockIfcAPI, init: vi.fn(async () => undefined), initSync: vi.fn() };
});

vi.mock('@ifc-lite/wasm', () => ({
  default: wasm.init,
  initSync: wasm.initSync,
  setGeometryProgressCallback: () => undefined,
  IfcAPI: wasm.MockIfcAPI,
}));

let originalSelf: unknown;
let originalPostMessage: unknown;
let importCounter = 0;

async function send(data: unknown): Promise<void> {
  (self as unknown as Worker).onmessage!({ data } as MessageEvent);
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(async () => {
  wasm.created.length = 0;
  const g = globalThis as Record<string, unknown>;
  originalSelf = g.self;
  originalPostMessage = g.postMessage;
  g.self = globalThis;
  g.postMessage = () => undefined;
  await import('./geometry.worker.js?reinit=' + ++importCounter);
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  if (originalSelf === undefined) delete g.self; else g.self = originalSelf;
  if (originalPostMessage === undefined) delete g.postMessage; else g.postMessage = originalPostMessage;
});

describe('geometry.worker.ts re-init on a prewarmed worker (#7036)', () => {
  it('frees the previous IfcAPI and replays this load\'s settings onto the new one', async () => {
    const module = {} as WebAssembly.Module;
    await send({ type: 'init', wasmModule: module });
    await send({ type: 'set-merge-layers', enabled: false });
    await send({ type: 'set-merge-layers', enabled: true }); // the leasing load's toggle, before its init
    await send({ type: 'init', wasmModule: module });
    expect(wasm.created).toHaveLength(2);
    expect(wasm.created[0].freed).toBe(true);
    expect(wasm.created[1].freed).toBe(false);
    expect(wasm.created[1].mergeLayers).toBe(true);
  });
});
