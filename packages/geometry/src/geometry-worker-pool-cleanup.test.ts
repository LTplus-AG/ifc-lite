/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => {
  const actions: string[] = [];
  let failCacheClear = false;
  let failFree = false;
  class IfcAPI {
    getMemory(): never { throw new Error('memory introspection failed'); }
    setEntityIndex(): void { actions.push('entity-index'); }
    clearPrePassCache(): void {
      actions.push('cache-clear');
      if (failCacheClear) throw new Error('cache cleanup failed');
    }
    free(): void {
      actions.push('api-free');
      if (failFree) throw new Error('API cleanup failed');
    }
  }
  return { IfcAPI, actions, setFailCacheClear(value: boolean) { failCacheClear = value; },
    setFailFree(value: boolean) { failFree = value; } };
});
vi.mock('@ifc-lite/wasm', () => ({
  default: async () => undefined, initSync: () => undefined,
  setGeometryProgressCallback: () => undefined, IfcAPI: engine.IfcAPI,
}));

const posted: Array<{ type?: string; token?: number; wasmHeapBytes?: number; message?: string }> = [];
let saved: Array<[string, unknown]>;
let epoch = 0;
async function send(data: unknown): Promise<void> {
  (self as unknown as Worker).onmessage!({ data } as MessageEvent);
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
beforeEach(async () => {
  engine.actions.length = 0; engine.setFailCacheClear(false); engine.setFailFree(false); posted.length = 0;
  const globals = globalThis as Record<string, unknown>;
  saved = ['self', 'postMessage', 'onmessage'].map(key => [key, globals[key]]);
  globals.self = globalThis; globals.postMessage = (data: typeof posted[number]) => posted.push(data);
  await import('./geometry.worker.js?pool-cleanup=' + ++epoch);
});
afterEach(() => {
  const globals = globalThis as Record<string, unknown>;
  for (const [key, value] of saved) { if (value === undefined) delete globals[key]; else globals[key] = value; }
});

it('#7036 throwing memory introspection still initializes, frees state, and acknowledges an unretainable heap', async () => {
  await send({ type: 'init' });
  expect(posted).toEqual([{ type: 'ready', wasmHeapBytes: 0 }]);
  await send({ type: 'set-entity-index', ids: new Uint32Array([1]), starts: new Uint32Array([0]), lengths: new Uint32Array([4]) });
  await send({ type: 'pool-reset', token: 7 });
  expect(engine.actions).toEqual(['entity-index', 'cache-clear', 'api-free']);
  expect(posted.at(-1)).toEqual({ type: 'pool-reset-done', token: 7, wasmHeapBytes: 0 });
  await send({ type: 'init' });
  // Reset cleared cached index state: a fresh API must not inherit the old model.
  expect(engine.actions).toEqual(['entity-index', 'cache-clear', 'api-free']);
  expect(posted.filter(event => event.type === 'error')).toEqual([]);
});

it('#7036 cache cleanup failure still frees the API and refuses reset admission', async () => {
  await send({ type: 'init' });
  await send({ type: 'set-entity-index', ids: new Uint32Array([1]), starts: new Uint32Array([0]), lengths: new Uint32Array([4]) });
  engine.setFailCacheClear(true);
  await send({ type: 'pool-reset', token: 9 });
  expect(engine.actions).toEqual(['entity-index', 'cache-clear', 'api-free']);
  expect(posted.some(event => event.type === 'pool-reset-done')).toBe(false);
  expect(posted.at(-1)?.type).toBe('error');
  expect(posted.at(-1)?.message).toContain('cache cleanup failed');
  engine.setFailCacheClear(false);
  await send({ type: 'init' });
  expect(engine.actions).toEqual(['entity-index', 'cache-clear', 'api-free']);
});

it('#7036 API free failure still retires load state and refuses reset admission', async () => {
  await send({ type: 'init' });
  await send({ type: 'set-entity-index', ids: new Uint32Array([1]), starts: new Uint32Array([0]), lengths: new Uint32Array([4]) });
  engine.setFailFree(true);
  await send({ type: 'pool-reset', token: 11 });
  expect(engine.actions).toEqual(['entity-index', 'cache-clear', 'api-free']);
  expect(posted.some(event => event.type === 'pool-reset-done')).toBe(false);
  expect(posted.at(-1)?.type).toBe('error');
  expect(posted.at(-1)?.message).toContain('API cleanup failed');
  engine.setFailFree(false);
  await send({ type: 'init' });
  // The old API is no longer held and the old index is not replayed onto its replacement.
  expect(engine.actions).toEqual(['entity-index', 'cache-clear', 'api-free']);
});
