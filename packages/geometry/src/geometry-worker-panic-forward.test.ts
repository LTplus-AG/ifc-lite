/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2527 follow-up: pins that `geometry.worker.ts` itself reads + consumes
 * ITS OWN realm's wasm panic-location stash and includes it on the
 * `{type:'error'}` message it posts back to the main thread — the half of
 * the fix `geometry-parallel-panic-forward.test.ts` cannot see, since that
 * fixture drives `processParallel` with a fully synthetic `Worker` and never
 * runs a line of this file.
 *
 * `geometry.worker.ts` assigns `self.onmessage = ...` at module scope, which
 * needs a `self` global — absent under vitest's default Node environment.
 * A minimal `self`/`postMessage` polyfill is installed BEFORE the dynamic
 * import so the module loads exactly as it would in a real worker realm.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WASM_PANIC_STASH_KEY } from './wasm-panic-forward.js';

const postedMessages: unknown[] = [];
let originalSelf: unknown;
let originalPostMessage: unknown;

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(async () => {
  postedMessages.length = 0;
  const g = globalThis as Record<string, unknown>;
  originalSelf = g.self;
  originalPostMessage = g.postMessage;
  g.self = globalThis;
  g.postMessage = (msg: unknown) => postedMessages.push(msg);
  delete g[WASM_PANIC_STASH_KEY];
  // Fresh module instance per test so `activeSession` etc. reset — the
  // worker file has meaningful top-level mutable state.
  await import('./geometry.worker.js?t=' + Date.now());
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  if (originalSelf === undefined) delete g.self; else g.self = originalSelf;
  if (originalPostMessage === undefined) delete g.postMessage; else g.postMessage = originalPostMessage;
  delete g[WASM_PANIC_STASH_KEY];
});

describe('geometry.worker.ts forwards this realm\'s wasm panic stash on error', () => {
  it('includes wasmPanicLocation/wasmPanicAt on the error message when a stash is present', async () => {
    const g = globalThis as Record<string, unknown>;
    g[WASM_PANIC_STASH_KEY] = { location: 'geometry/src/mesh_weld.rs:412:9', at: 1234 };

    // `stream-end` with no prior `stream-start` throws synchronously inside
    // handleMessage's try block (see geometry.worker.ts), landing in the
    // inner catch this fix instruments — no WASM init required.
    (self as unknown as Worker).onmessage!({ data: { type: 'stream-end' } } as MessageEvent);
    await flushMicrotasks();

    const errorMsg = postedMessages.find((m) => (m as { type?: string }).type === 'error') as
      | { message?: string; wasmPanicLocation?: string; wasmPanicAt?: number }
      | undefined;
    expect(errorMsg?.message).toMatch(/stream-end received before stream-start/);
    expect(errorMsg?.wasmPanicLocation).toBe('geometry/src/mesh_weld.rs:412:9');
    expect(errorMsg?.wasmPanicAt).toBe(1234);
    // Consumed, same as the main-thread gate's own rule.
    expect(g[WASM_PANIC_STASH_KEY]).toBeUndefined();
  });

  it('omits the panic fields entirely when there is no stash', async () => {
    (self as unknown as Worker).onmessage!({ data: { type: 'stream-end' } } as MessageEvent);
    await flushMicrotasks();

    const errorMsg = postedMessages.find((m) => (m as { type?: string }).type === 'error') as
      | { wasmPanicLocation?: string; wasmPanicAt?: number }
      | undefined;
    expect(errorMsg).toBeDefined();
    expect('wasmPanicLocation' in (errorMsg as object)).toBe(false);
    expect('wasmPanicAt' in (errorMsg as object)).toBe(false);
  });
});
