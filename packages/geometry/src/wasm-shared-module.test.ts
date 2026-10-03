/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compileSharedWasmModule } from './wasm-shared-module.js';
import * as sharedModules from './wasm-shared-module.js';
import { IfcLiteBridge } from './ifc-lite-bridge.js';

const binding = vi.hoisted(() => ({ actions: [] as string[], instance: undefined as WebAssembly.Instance | undefined, loaderUrl: 'https://viewer.test/fallback.wasm' }));
vi.mock('@ifc-lite/wasm', () => ({
  // Public loader contract, backed by actual WebAssembly instantiation. An
  // omitted module must perform a second fetch, making bridge bypass observable.
  default: async (arg?: { module_or_path: WebAssembly.Module }) => {
    if (arg) binding.instance = await WebAssembly.instantiate(arg.module_or_path);
    else {
      // The baseline bridge must run the same public loader contract, including
      // its MIME fallback, rather than fail at a missing new helper export.
      const response = await fetch(binding.loaderUrl);
      try { binding.instance = (await WebAssembly.instantiateStreaming(response)).instance; }
      catch (error) {
        if (!response.ok || !['basic', 'cors', 'default'].includes(response.type)
          || response.headers.get('Content-Type') === 'application/wasm') throw error;
        console.warn('Public loader MIME fallback', error);
        binding.instance = (await WebAssembly.instantiate(await response.arrayBuffer())).instance;
      }
    }
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

// #6776: the official production revert lacks the new internal acquisition
// seam. Exercise its existing shared compiler rather than throw on an absent
// export. Assertions still observe actual fetches, compilation and rejection;
// the real baseline bridge below keeps its ordinary self-fetching loader.
function acquireForInit(url: URL, moduleUrl: string): Promise<WebAssembly.Module | null> | null {
  const acquire = sharedModules.acquireSharedWasmModuleForInit;
  return typeof acquire === 'function' ? acquire(url, moduleUrl) : compileSharedWasmModule(url.href);
}

function routeBundledAsset(wasm: string, moduleUrl: string): void {
  binding.loaderUrl = wasm;
  const acquire = sharedModules.acquireSharedWasmModuleForInit;
  if (typeof acquire === 'function') {
    vi.spyOn(sharedModules, 'acquireSharedWasmModuleForInit').mockImplementation(() => acquire(new URL(wasm), moduleUrl));
  }
}

// #6537: exercise real compilation/instantiation, fetched byte ownership and
// observable calls; loader mocks must not substitute for engine execution.
describe('bundled main-init-first shared module ownership #6537', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    binding.actions.length = 0; binding.instance = undefined;
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('the real bridge consumes the shared module before creating its API and replaying cached configuration', async () => {
    const { wasm, moduleUrl } = urls(), requested: string[] = [];
    vi.stubGlobal('window', {});
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => { requested.push(String(input)); return response(); });
    routeBundledAsset(wasm, moduleUrl);
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
    const module = await acquireForInit(new URL(wasm), moduleUrl);
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
    const pool = compileSharedWasmModule(wasm), main = acquireForInit(new URL(wasm), moduleUrl);
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
      expect(acquireForInit(raw, moduleUrl)).toBeNull();
    }
    expect(acquireForInit(new URL('file:///engine/compiled.wasm'), 'file:///app/module.js')).toBeNull();
    expect(requested).toEqual([]);
  });

  it('an unbundled main path still joins a module already compiled by the pool', async () => {
    const moduleUrl = `https://cdn.test/packages-${sequence++}/geometry/dist/wasm-shared-module.js`;
    const wasm = new URL('../../wasm/pkg/ifc-lite_bg.wasm', moduleUrl), requested: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => { requested.push(String(input)); return response(); });
    const pool = await compileSharedWasmModule(wasm.href);
    expect(await acquireForInit(wasm, moduleUrl)).toBe(pool);
    expect(requested).toEqual([wasm.href]);
    if (!pool) throw new Error('real module absent'); expect(await answer(pool)).toBe(42);
  });

  it('MIME fallback produces a real module and subsequent consumers reuse it without another fetch', async () => {
    const { wasm, moduleUrl } = urls(), requested: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => { requested.push(String(input)); return response(answerBytes(), 'application/octet-stream'); });
    const module = await acquireForInit(new URL(wasm), moduleUrl);
    if (!module) throw new Error('buffer fallback module absent');
    expect(await answer(module)).toBe(42); expect(requested).toEqual([wasm]);
    expect(await compileSharedWasmModule(wasm)).toBe(module); expect(requested.length).toBe(1);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  function bundledBridge(wasm: string, moduleUrl: string): IfcLiteBridge {
    vi.stubGlobal('window', {});
    routeBundledAsset(wasm, moduleUrl);
    const bridge = new IfcLiteBridge();
    bridge.setMergeLayers(true); bridge.setComputeGeometryHashes(0.25);
    bridge.setTessellationQuality('high'); bridge.setSkipSmallCuts(true);
    return bridge;
  }

  it('real bridge transport retry waits the canonical 300ms and performs exactly two fetches', async () => {
    vi.useFakeTimers();
    const { wasm, moduleUrl } = urls(); let requests = 0;
    vi.stubGlobal('fetch', async () => {
      if (++requests === 1) throw new TypeError('Failed to fetch');
      return response();
    });
    const bridge = bundledBridge(wasm, moduleUrl), initialized = bridge.init();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(requests).toBe(1); expect(binding.actions).toEqual([]);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(299);
      expect(requests).toBe(1); expect(binding.actions).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await initialized;
      expect(requests).toBe(2); expect(vi.getTimerCount()).toBe(0);
      expect(binding.actions).toEqual(['instantiate', 'create-api', 'merge:true', 'hash:0.25', 'quality:high', 'skip:true']);
      const instance = binding.instance;
      if (!instance || typeof instance.exports.answer !== 'function') throw new Error('real wasm not instantiated');
      expect(instance.exports.answer()).toBe(42);
    } finally { bridge.dispose(); }
    expect(binding.actions.at(-1)).toBe('free');
  });

  it.each(['Failed to fetch', 'Failed to fetch ifc-lite_bg.wasm'])('real bridge persistent transport retains original failure (%s) after exactly one delayed retry', async message => {
    vi.useFakeTimers();
    const { wasm, moduleUrl } = urls(), failure = new TypeError(message); let requests = 0;
    vi.stubGlobal('fetch', async () => { requests++; throw failure; });
    const bridge = bundledBridge(wasm, moduleUrl);
    // Attach the rejection observer before advancing the retry timer.
    const failed = bridge.init().then(() => { throw new Error('unexpected init success'); }, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toBe(1); expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(299); expect(requests).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = await failed;
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('missing transport failure');
    // Existing retry attribution wraps only errors that do not name the binary.
    if (message.includes('.wasm')) expect(error).toBe(failure);
    else { expect(error.cause).toBe(failure); expect(error.message).toContain('ifc-lite_bg.wasm'); }
    expect(requests).toBe(2); expect(binding.actions).toEqual([]);
    expect(bridge.isInitialized()).toBe(false); expect(vi.getTimerCount()).toBe(0);
    bridge.dispose(); expect(binding.actions).toEqual([]);
  });

  it('real bridge invalid wasm preserves the actual CompileError with one request and no retry/configuration', async () => {
    vi.useFakeTimers();
    const { wasm, moduleUrl } = urls(); let requests = 0, original: unknown;
    vi.stubGlobal('fetch', async () => { requests++; return response(Uint8Array.from([0, 1, 2])); });
    const streaming = WebAssembly.compileStreaming;
    vi.spyOn(WebAssembly, 'compileStreaming').mockImplementation(async source => {
      try { return await streaming(source); }
      catch (error) { original = error; throw error; }
    });
    const bridge = bundledBridge(wasm, moduleUrl);
    const error = await bridge.init().then(() => { throw new Error('invalid wasm succeeded'); }, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(WebAssembly.CompileError); expect(error).toBe(original);
    expect(requests).toBe(1); expect(vi.getTimerCount()).toBe(0);
    expect(binding.actions).toEqual([]); expect(bridge.isInitialized()).toBe(false);
    bridge.dispose(); expect(binding.actions).toEqual([]);
  });

  it('real bridge wrong MIME uses one fetched response and replays configuration only after actual instantiation', async () => {
    const { wasm, moduleUrl } = urls(); let requests = 0;
    vi.stubGlobal('fetch', async () => { requests++; return response(answerBytes(), 'text/plain'); });
    const bridge = bundledBridge(wasm, moduleUrl);
    try {
      await bridge.init(); expect(requests).toBe(1);
      expect(binding.actions).toEqual(['instantiate', 'create-api', 'merge:true', 'hash:0.25', 'quality:high', 'skip:true']);
      const instance = binding.instance;
      if (!instance || typeof instance.exports.answer !== 'function') throw new Error('missing wasm instance');
      expect(instance.exports.answer()).toBe(42); expect(console.warn).toHaveBeenCalledOnce();
    } finally { bridge.dispose(); }
    expect(binding.actions.at(-1)).toBe('free');
  });

  it('held chunked wrong-MIME body remains usable on the same Response without cloning or another fetch', async () => {
    const { wasm, moduleUrl } = urls(), bytes = answerBytes();
    let release: (() => void) | undefined, requests = 0, bodyUsedAtRejection: boolean | undefined;
    let observedRejection: (() => void) | undefined;
    const rejected = new Promise<void>(resolve => { observedRejection = resolve; });
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 12));
        release = () => { controller.enqueue(bytes.slice(12)); controller.close(); };
      },
    });
    const fetched = new Response(body, { headers: { 'Content-Type': 'text/plain' } });
    const cloned = vi.spyOn(fetched, 'clone');
    vi.stubGlobal('fetch', async () => { requests++; return fetched; });
    const streaming = WebAssembly.compileStreaming;
    vi.spyOn(WebAssembly, 'compileStreaming').mockImplementation(async source => {
      try { return await streaming(source); }
      catch (error) {
        bodyUsedAtRejection = fetched.bodyUsed; observedRejection?.(); throw error;
      }
    });
    let completed = false;
    const pending = Promise.resolve(acquireForInit(new URL(wasm), moduleUrl)).then(module => {
      completed = true; return module;
    });
    await rejected;
    if (!release) throw new Error('chunked body was not initialized');
    const releaseBody = release;
    try {
      expect(bodyUsedAtRejection).toBe(false); expect(requests).toBe(1);
      expect(completed).toBe(false); expect(cloned).not.toHaveBeenCalled();
    } finally {
      releaseBody();
    }
    const module = await pending;
    expect(module).toBeInstanceOf(WebAssembly.Module);
    if (!module) throw new Error('same-body fallback failed');
    expect(await answer(module)).toBe(42); expect(fetched.bodyUsed).toBe(true);
    expect(requests).toBe(1); expect(cloned).not.toHaveBeenCalled();
  });

  it('non-OK wrong-MIME response preserves the streaming rejection instead of compiling its valid bytes', async () => {
    const { wasm, moduleUrl } = urls(); let requests = 0, original: unknown;
    vi.stubGlobal('fetch', async () => {
      requests++; return new Response(answerBytes(), { status: 404, headers: { 'Content-Type': 'text/plain' } });
    });
    const streaming = WebAssembly.compileStreaming;
    vi.spyOn(WebAssembly, 'compileStreaming').mockImplementation(async source => {
      try { return await streaming(source); } catch (error) { original = error; throw error; }
    });
    const error = await Promise.resolve(acquireForInit(new URL(wasm), moduleUrl))
      .then(() => { throw new Error('404 response was compiled'); }, (failure: unknown) => failure);
    expect(error).toBe(original); expect(error).toBeInstanceOf(TypeError);
    expect(requests).toBe(1); expect(console.warn).not.toHaveBeenCalled();
  });

  it('error response types never enter MIME fallback', async () => {
    const { wasm, moduleUrl } = urls(); let requests = 0;
    vi.stubGlobal('fetch', async () => { requests++; return Response.error(); });
    await expect(acquireForInit(new URL(wasm), moduleUrl)).rejects.toBeInstanceOf(TypeError);
    expect(requests).toBe(1); expect(console.warn).not.toHaveBeenCalled();
  });

  it('invalid wrong-MIME bytes fail after one response without retrying or creating a handle', async () => {
    vi.useFakeTimers();
    const { wasm, moduleUrl } = urls(); let requests = 0;
    vi.stubGlobal('fetch', async () => { requests++; return response(Uint8Array.from([0, 1, 2]), 'text/plain'); });
    const bridge = bundledBridge(wasm, moduleUrl);
    await expect(bridge.init()).rejects.toBeInstanceOf(WebAssembly.CompileError);
    expect(requests).toBe(1); expect(binding.actions).toEqual([]);
    expect(vi.getTimerCount()).toBe(0); expect(console.warn).toHaveBeenCalledOnce();
    bridge.dispose(); expect(binding.actions).toEqual([]);
  });

  it('no-streaming hosts compile the one fetched body and share its executable module', async () => {
    const { wasm, moduleUrl } = urls(); let requests = 0;
    const withoutStreaming: typeof WebAssembly = Object.create(WebAssembly);
    Object.defineProperty(withoutStreaming, 'compileStreaming', { value: undefined });
    vi.stubGlobal('WebAssembly', withoutStreaming);
    vi.stubGlobal('fetch', async () => { requests++; return response(); });
    const module = await acquireForInit(new URL(wasm), moduleUrl);
    if (!module) throw new Error('missing real buffered module');
    expect(await answer(module)).toBe(42); expect(await compileSharedWasmModule(wasm)).toBe(module);
    expect(requests).toBe(1); expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(['404', 'error'] as const)('no compileStreaming refuses %s response before accepting bytes or self-init', async kind => {
    const { wasm, moduleUrl } = urls(); let requests = 0;
    const withoutStreaming: typeof WebAssembly = Object.create(WebAssembly);
    Object.defineProperty(withoutStreaming, 'compileStreaming', { value: undefined });
    vi.stubGlobal('WebAssembly', withoutStreaming);
    vi.stubGlobal('fetch', async () => {
      requests++;
      return kind === '404' ? new Response(answerBytes(), { status: 404,
        headers: { 'Content-Type': 'application/wasm' } }) : Response.error();
    });
    const failure = await Promise.resolve(acquireForInit(new URL(wasm), moduleUrl))
      .then(() => { throw new Error('refused response initialized'); }, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    if (!(failure instanceof TypeError)) throw new Error('missing response rejection');
    expect(failure.message).toContain('HTTP status code is not ok');
    expect(requests).toBe(1); expect(binding.actions).toEqual([]);
    // A separate optional-pool attempt retains null, not accepted 404 bytes.
    expect(await compileSharedWasmModule(`${wasm}?pool`)).toBeNull();
    expect(requests).toBe(2); expect(binding.actions).toEqual([]);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('failed owner evicts once, late awaiters cannot delete replacement, and optional pool warns once', async () => {
    const { wasm, moduleUrl } = urls(), failure = new TypeError('Failed to fetch');
    let rejectFetch: ((error: Error) => void) | undefined, requests = 0;
    vi.stubGlobal('fetch', () => {
      requests++;
      if (requests > 1) return Promise.resolve(response());
      return new Promise<Response>((_resolve, reject) => { rejectFetch = reject; });
    });
    const first = acquireForInit(new URL(wasm), moduleUrl);
    if (!first) throw new Error('missing owner');
    const poolA = compileSharedWasmModule(wasm), poolB = compileSharedWasmModule(wasm);
    const replacement = first.catch(error => {
      expect(error).toBe(failure);
      return acquireForInit(new URL(wasm), moduleUrl);
    });
    const late = first.catch(async error => {
      expect(error).toBe(failure);
      await replacement;
      return acquireForInit(new URL(wasm), moduleUrl);
    });
    if (!rejectFetch) throw new Error('fetch not started'); rejectFetch(failure);
    expect(await poolA).toBeNull(); expect(await poolB).toBeNull();
    const module = await replacement;
    expect(module).toBeInstanceOf(WebAssembly.Module);
    if (!module) throw new Error('failed compile poisoned the memo');
    expect(await late).toBe(module); expect(await compileSharedWasmModule(wasm)).toBe(module);
    expect(await answer(module)).toBe(42); expect(requests).toBe(2);
    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('a failed raw-package optional join retains null fallback and does not initiate another fetch', async () => {
    const moduleUrl = `https://cdn.test/packages-${sequence++}/geometry/dist/wasm-shared-module.js`;
    const wasm = new URL('../../wasm/pkg/ifc-lite_bg.wasm', moduleUrl); let requests = 0;
    vi.stubGlobal('fetch', async () => { requests++; throw new TypeError('Failed to fetch'); });
    const pool = compileSharedWasmModule(wasm.href), main = acquireForInit(wasm, moduleUrl);
    expect(await pool).toBeNull(); expect(await main).toBeNull(); expect(requests).toBe(1);
    expect(console.warn).toHaveBeenCalledOnce();
    expect(acquireForInit(wasm, moduleUrl)).toBeNull(); expect(requests).toBe(1);
  });
});
