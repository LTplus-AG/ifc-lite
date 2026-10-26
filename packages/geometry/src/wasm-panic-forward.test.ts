/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import * as lifecycle from '@ifc-lite/wasm-lifecycle';
import { WASM_PANIC_STASH_KEY, restashWasmPanicLocation, takeWasmPanicStash } from './wasm-panic-forward.js';

// #4247: malformed inputs and trap classification are covered canonically in
// wasm-lifecycle; retain real realm-to-realm behavior through this import path.
describe('WASM panic forwarding', () => {
  it('exports the canonical stash key and forwarding functions', () => {
    expect(WASM_PANIC_STASH_KEY).toBe(lifecycle.WASM_PANIC_STASH_KEY);
    expect(takeWasmPanicStash).toBe(lifecycle.takeWasmPanicStash);
    expect(restashWasmPanicLocation).toBe(lifecycle.restashWasmPanicLocation);
  });

  it('consumes a worker stash and forwards it only with a trap-shaped error', () => {
    const stash = { location: 'geometry/src/mesh_weld.rs:412:9', at: 1000 };
    const worker: Record<string, unknown> = { [WASM_PANIC_STASH_KEY]: stash };
    const main: Record<string, unknown> = {};
    const forwarded = takeWasmPanicStash(worker);
    expect(forwarded).toEqual(stash);
    expect(worker[WASM_PANIC_STASH_KEY]).toBeUndefined();

    restashWasmPanicLocation(main, forwarded?.location, forwarded?.at, 'Failed to fetch');
    expect(main[WASM_PANIC_STASH_KEY]).toBeUndefined();

    restashWasmPanicLocation(main, forwarded?.location, forwarded?.at, 'unreachable');
    expect(main[WASM_PANIC_STASH_KEY]).toEqual(stash);
    expect(takeWasmPanicStash(main)).toEqual(stash);
    expect(takeWasmPanicStash(main)).toBeUndefined();
  });
});
