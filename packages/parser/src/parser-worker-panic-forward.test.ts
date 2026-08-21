/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2527 follow-up: pins that `parser.worker.ts` itself reads + consumes ITS
 * OWN realm's wasm panic-location stash and includes it on the
 * `{type:'error'}` message it posts back — the half of the fix
 * `worker-parser-panic-forward.test.ts` cannot see, since that fixture
 * drives `WorkerParser` with a fully synthetic `Worker` and never runs a
 * line of this file.
 *
 * `parser.worker.ts` assigns `self.onmessage = ...` at module scope, which
 * needs a `self` global — absent under vitest's default Node environment. A
 * minimal `self`/`postMessage` polyfill is installed BEFORE the dynamic
 * import so the module loads exactly as it would in a real worker realm.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WASM_PANIC_STASH_KEY } from './wasm-panic-forward.js';

const postedMessages: unknown[] = [];
let originalSelf: unknown;
let originalPostMessage: unknown;

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

// Monotonic, not `Date.now()`: two tests importing within the same
// millisecond would otherwise resolve to the same module specifier and
// share a `parser.worker.js` instance, silently breaking per-test isolation.
let importCounter = 0;

beforeEach(async () => {
  postedMessages.length = 0;
  const g = globalThis as Record<string, unknown>;
  originalSelf = g.self;
  originalPostMessage = g.postMessage;
  g.self = globalThis;
  g.postMessage = (msg: unknown) => postedMessages.push(msg);
  delete g[WASM_PANIC_STASH_KEY];
  await import('./parser.worker.js?t=' + ++importCounter);
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  if (originalSelf === undefined) delete g.self; else g.self = originalSelf;
  if (originalPostMessage === undefined) delete g.postMessage; else g.postMessage = originalPostMessage;
  delete g[WASM_PANIC_STASH_KEY];
});

describe('parser.worker.ts forwards this realm\'s wasm panic stash on error', () => {
  it('includes wasmPanicLocation/wasmPanicAt on the error message when a stash is present', async () => {
    const g = globalThis as Record<string, unknown>;
    g[WASM_PANIC_STASH_KEY] = { location: 'parser/src/tokenizer.rs:88:5', at: 5678 };

    // A garbage `source` (not an ArrayBuffer/SharedArrayBuffer) makes
    // `parseColumnar`'s `new Uint8Array(buffer)` throw synchronously — no
    // real WASM parse needed to reach the outer catch this fix instruments.
    (self as unknown as Worker).onmessage!({
      data: { type: 'parse', id: 'req-1', source: {} },
    } as unknown as MessageEvent);
    await flushMicrotasks();

    const errorMsg = postedMessages.find((m) => (m as { type?: string }).type === 'error') as
      | { message?: string; wasmPanicLocation?: string; wasmPanicAt?: number }
      | undefined;
    expect(errorMsg).toBeDefined();
    expect(errorMsg?.wasmPanicLocation).toBe('parser/src/tokenizer.rs:88:5');
    expect(errorMsg?.wasmPanicAt).toBe(5678);
    expect(g[WASM_PANIC_STASH_KEY]).toBeUndefined();
    // 4462ms measured on a green CI run against the 5000ms
    // default. 30_000 by convention (#2905, AB22_TIMEOUT_MS), not a
    // per-test derivation: this spins up a real worker and forces a wasm panic (#2948).
  }, 30_000);

  it('omits the panic fields entirely when there is no stash', async () => {
    (self as unknown as Worker).onmessage!({
      data: { type: 'parse', id: 'req-1', source: {} },
    } as unknown as MessageEvent);
    await flushMicrotasks();

    const errorMsg = postedMessages.find((m) => (m as { type?: string }).type === 'error') as
      | { wasmPanicLocation?: string; wasmPanicAt?: number }
      | undefined;
    expect(errorMsg).toBeDefined();
    expect('wasmPanicLocation' in (errorMsg as object)).toBe(false);
    expect('wasmPanicAt' in (errorMsg as object)).toBe(false);
  });
});
