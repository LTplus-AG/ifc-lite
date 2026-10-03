/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireSharedWasmModuleForInit, compileSharedWasmModule } from './wasm-shared-module.js';
import { initWasmWithRetry } from './wasm-init-retry.js';
import * as sharedModules from './wasm-shared-module.js';
import { IfcLiteBridge } from './ifc-lite-bridge.js';

const binding = vi.hoisted(() => ({ actions: [] as string[], instance: undefined as WebAssembly.Instance | undefined }));
vi.mock('@ifc-lite/wasm', () => ({
  // Public loader contract, backed by actual WebAssembly instantiation. An
  // omitted module must perform a second fetch, making bridge bypass observable.
  default: async (arg?: { module_or_path: WebAssembly.Module }) => {
    binding.instance = arg
      ? await WebAssembly.instantiate(arg.module_or_path)
      : (await WebAssembly.instantiateStreaming(fetch('https://viewer.test/fallback.wasm'))).instance;
    binding.actions.push('instantiate');
  },
  IfcAPI: class {
    constructor() { binding.actions.push('create-api'); }
    setMergeLayers(value: boolean) { binding.actions.push(`merge:${value}`); }
    setComputeGeometryHashes(value: number | null) { binding.actions.push(`hash:${value}`); }
    setTessellationQuality(value: string | null) { binding.actions.push(`quality:${value}`); }
    setSkipSmallCuts(value: boolean) { binding.actions.push(`skip:${value}`); }
    free() { binding.actions.push('free'); }
  },
}));

// Real executable wasm: () -> i32, exported as answer. No IFC/runtime artifact.
const answerBytes = (value = 42): Uint8Array<ArrayBuffer> => Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127,
  3, 2, 1, 0, 7, 10, 1, 6, 97, 110, 115, 119, 101, 114, 0, 0,
  10, 6, 1, 4, 0, 65, value, 11,
]);
async function answer(module: WebAssembly.Module): Promise<number> {
  const instance = await WebAssembly.instantiate(module);
  const fn = instance.exports.answer;
  if (typeof fn !== 'function') throw new Error('missing real wasm answer export');
  return fn();
}
let sequence = 0;
const urls = () => ({ moduleUrl: 'https://viewer.test/assets/index.js',
  wasm: `https://viewer.test/assets/engine-${sequence++}.wasm` });
const response = (bytes = answerBytes(), mime = 'application/wasm') =>
  new Response(bytes, { headers: { 'Content-Type': mime } });

// #6537: exercise real compilation/instantiation, fetched byte ownership and
// observable calls; loader mocks must not substitute for engine execution.
describe('bundled main-init-first shared module ownership #6537', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    binding.actions.length = 0; binding.instance = undefined;
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('the real bridge consumes the shared module before creating its API and replaying cached configuration', async () => {
    const { wasm, moduleUrl } = urls(), requested: string[] = [];
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => { requested.push(String(input)); return response(); });
    const acquire = acquireSharedWasmModuleForInit;
    vi.spyOn(sharedModules, 'acquireSharedWasmModuleForInit').mockImplementation(() => acquire(new URL(wasm), moduleUrl));
    const bridge = new IfcLiteBridge();
    bridge.setMergeLayers(true); bridge.setComputeGeometryHashes(0.25);
    bridge.setTessellationQuality('high'); bridge.setSkipSmallCuts(true);
    expect(binding.actions).toEqual([]);
    try {
      await bridge.init();
      expect(bridge.isInitialized()).toBe(true);
      expect(binding.actions).toEqual(['instantiate', 'create-api', 'merge:true', 'hash:0.25', 'quality:high', 'skip:true']);
      if (!binding.instance) throw new Error('bridge did not instantiate real wasm');
      const fn = binding.instance.exports.answer;
      if (typeof fn !== 'function') throw new Error('missing executable wasm export');
      expect(fn()).toBe(42); expect(requested).toEqual([wasm]);
      expect(await compileSharedWasmModule(wasm)).toBeInstanceOf(WebAssembly.Module);
      expect(requested).toEqual([wasm]);
    } finally { bridge.dispose(); }
    expect(binding.actions.at(-1)).toBe('free');
  });

  it('main-first compiles one fetched body, executes it and hands the same module to the later pool', async () => {
    const { wasm, moduleUrl } = urls(), requested: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => { requested.push(String(input)); return response(); });
    const module = await acquireSharedWasmModuleForInit(new URL(wasm), moduleUrl);
    expect(module).toBeInstanceOf(WebAssembly.Module);
    if (!module) throw new Error('compiled module absent');
    expect(await answer(module)).toBe(42);
    expect(await compileSharedWasmModule(wasm)).toBe(module);
    expect(requested).toEqual([wasm]);
  });

  it('pool-first and overlapping main acquisition share one in-flight body and preserve URL isolation', async () => {
    const { wasm, moduleUrl } = urls(); let release: (() => void) | undefined;
    const pending = new Promise<void>(accept => { release = accept; }), requested: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      requested.push(String(input)); await pending; return response(String(input) === wasm ? answerBytes() : answerBytes(7));
    });
    const pool = compileSharedWasmModule(wasm), main = acquireSharedWasmModuleForInit(new URL(wasm), moduleUrl);
    const other = compileSharedWasmModule(`${wasm}?version=other`);
    expect(requested).toEqual([wasm, `${wasm}?version=other`]); release?.();
    const [a, b, c] = await Promise.all([pool, main, other]);
    expect(a).toBe(b); expect(c).not.toBe(a);
    if (!a || !c) throw new Error('real compiled module missing');
    expect(await answer(a)).toBe(42); expect(await answer(c)).toBe(7);
  });

  it('unbundled scoped, nested dependency and Node file URLs never initiate speculative fetches', () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => { requested.push(String(input)); return response(); });
    for (const moduleUrl of [
      'https://cdn.test/node_modules/@ifc-lite/geometry/dist/wasm-shared-module.js',
      'https://cdn.test/node_modules/consumer/node_modules/@ifc-lite/geometry/dist/wasm-shared-module.js',
      'https://cdn.test/@ifc-lite/geometry@7/dist/wasm-shared-module.js',
      'file:///workspace/packages/geometry/src/wasm-shared-module.ts',
    ]) {
      const raw = new URL('../../wasm/pkg/ifc-lite_bg.wasm', moduleUrl);
      expect(acquireSharedWasmModuleForInit(raw, moduleUrl)).toBeNull();
    }
    expect(acquireSharedWasmModuleForInit(new URL('file:///engine/compiled.wasm'), 'file:///app/module.js')).toBeNull();
    expect(requested).toEqual([]);
  });

  it('an unbundled main path still joins a module already compiled by the pool', async () => {
    const moduleUrl = `https://cdn.test/packages-${sequence++}/geometry/dist/wasm-shared-module.js`;
    const wasm = new URL('../../wasm/pkg/ifc-lite_bg.wasm', moduleUrl), requested: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => { requested.push(String(input)); return response(); });
    const pool = await compileSharedWasmModule(wasm.href);
    expect(await acquireSharedWasmModuleForInit(wasm, moduleUrl)).toBe(pool);
    expect(requested).toEqual([wasm.href]);
    if (!pool) throw new Error('real module absent'); expect(await answer(pool)).toBe(42);
  });

  it('MIME fallback produces a real module and subsequent consumers reuse it without another fetch', async () => {
    const { wasm, moduleUrl } = urls(), requested: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => { requested.push(String(input)); return response(answerBytes(), 'application/octet-stream'); });
    const module = await acquireSharedWasmModuleForInit(new URL(wasm), moduleUrl);
    if (!module) throw new Error('buffer fallback module absent');
    expect(await answer(module)).toBe(42); expect(requested).toEqual([wasm, wasm]);
    expect(await compileSharedWasmModule(wasm)).toBe(module); expect(requested.length).toBe(2);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('failed transport and invalid bytes evict only the failed URL, leaving ordinary loader retry semantics', async () => {
    for (const failure of ['transport', 'invalid'] as const) {
      const { wasm, moduleUrl } = urls(); let recovered = false, requests = 0;
      vi.stubGlobal('fetch', async () => {
        requests++;
        if (recovered) return response();
        if (failure === 'transport') throw new TypeError('Failed to fetch');
        return response(Uint8Array.from([0, 1, 2]));
      });
      expect(await acquireSharedWasmModuleForInit(new URL(wasm), moduleUrl)).toBeNull();
      expect(requests).toBe(2); recovered = true;
      const module = await acquireSharedWasmModuleForInit(new URL(wasm), moduleUrl);
      if (!module) throw new Error('failure poisoned the memo');
      expect(await answer(module)).toBe(42); expect(requests).toBe(3);
    }
    let loads = 0, sleeps = 0;
    await initWasmWithRetry(async () => {
      loads++;
      if (loads === 1) throw new TypeError('Failed to fetch');
      expect(await answer(await WebAssembly.compile(answerBytes()))).toBe(42);
    }, { sleep: async () => { sleeps++; } });
    expect(loads).toBe(2); expect(sleeps).toBe(1);
    loads = 0;
    await expect(initWasmWithRetry(async () => { loads++; await WebAssembly.compile(Uint8Array.from([0, 1, 2])); })).rejects.toBeInstanceOf(WebAssembly.CompileError);
    expect(loads).toBe(1);
  });
});
