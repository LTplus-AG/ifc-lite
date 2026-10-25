/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, expect, it, vi } from 'vitest';
import { WorkerParser } from './worker-parser.js';

class ModuleBoundary {
  static instances: ModuleBoundary[] = [];
  messages: Array<{ type: string; id?: string }> = [];
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  terminated = false;
  constructor() { ModuleBoundary.instances.push(this); }
  postMessage(message: { type: string; id?: string }): void { this.messages.push(message); }
  terminate(): void { this.terminated = true; }
}
afterEach(() => { vi.unstubAllGlobals(); ModuleBoundary.instances = []; });

it('#7036 starts a parser while shared compilation is pending and aborts without waiting for it', async () => {
  vi.stubGlobal('Worker', ModuleBoundary);
  let compile!: (module: WebAssembly.Module | null) => void;
  const wasmModulePromise = new Promise<WebAssembly.Module | null>(resolve => { compile = resolve; });
  const controller = new AbortController();
  const parser = new WorkerParser();
  const parse = parser.parseColumnar(new SharedArrayBuffer(8), {
    wasmModulePromise, waitForEntityIndex: true, signal: controller.signal,
  });
  expect(ModuleBoundary.instances).toHaveLength(1);
  const worker = ModuleBoundary.instances[0];
  expect(worker.messages.map(message => message.type)).toEqual(['parse']);
  controller.abort(new Error('cancel pending compilation'));
  await expect(parse).rejects.toThrow('cancel pending compilation');
  expect(worker.terminated).toBe(true);
  compile(null);
  await Promise.resolve();
  expect(worker.messages.map(message => message.type)).toEqual(['parse']);
});

it('#7036 delivers a compiled module only to its still-active request ID', async () => {
  vi.stubGlobal('Worker', ModuleBoundary);
  let compile!: (module: WebAssembly.Module | null) => void;
  const wasmModulePromise = new Promise<WebAssembly.Module | null>(resolve => { compile = resolve; });
  const parser = new WorkerParser();
  const firstAbort = new AbortController();
  const first = parser.parseColumnar(new SharedArrayBuffer(8), { wasmModulePromise, signal: firstAbort.signal });
  const second = parser.parseColumnar(new SharedArrayBuffer(8), { wasmModulePromise });
  firstAbort.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  compile(null);
  await Promise.resolve();
  const [old, current] = ModuleBoundary.instances;
  expect(old.messages.map(message => message.type)).toEqual(['parse']);
  expect(current.messages.map(message => message.type)).toEqual(['parse', 'wasm-module']);
  expect(current.messages[1].id).toBe(current.messages[0].id);
  parser.terminate();
  await expect(second).rejects.toMatchObject({ name: 'AbortError' });
});
