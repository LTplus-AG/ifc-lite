/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { WASM_PANIC_STASH_KEY, restashWasmPanicLocation, takeWasmPanicStash } from './wasm-panic-forward.js';

describe('takeWasmPanicStash', () => {
  it('reads and consumes a well-formed stash', () => {
    const realm: Record<string, unknown> = {
      [WASM_PANIC_STASH_KEY]: { location: 'geometry/src/mesh_weld.rs:412:9', at: 1000 },
    };
    const stash = takeWasmPanicStash(realm);
    expect(stash).toEqual({ location: 'geometry/src/mesh_weld.rs:412:9', at: 1000 });
    expect(realm[WASM_PANIC_STASH_KEY]).toBeUndefined();
  });

  it('returns undefined when no stash is present', () => {
    const realm: Record<string, unknown> = {};
    expect(takeWasmPanicStash(realm)).toBeUndefined();
  });

  it('consumes a malformed stash too, so it never lingers to mislabel a later trap', () => {
    const realm: Record<string, unknown> = { [WASM_PANIC_STASH_KEY]: 'not-an-object' };
    expect(takeWasmPanicStash(realm)).toBeUndefined();
    expect(realm[WASM_PANIC_STASH_KEY]).toBeUndefined();
  });

  it('rejects a non-string location or non-number at', () => {
    const realm1: Record<string, unknown> = { [WASM_PANIC_STASH_KEY]: { location: 42, at: 1000 } };
    expect(takeWasmPanicStash(realm1)).toBeUndefined();
    const realm2: Record<string, unknown> = { [WASM_PANIC_STASH_KEY]: { location: 'x.rs:1:1', at: '1000' } };
    expect(takeWasmPanicStash(realm2)).toBeUndefined();
  });

  it('rejects a non-finite at (NaN/Infinity), which would otherwise pass the TTL gate trivially', () => {
    const realmNaN: Record<string, unknown> = { [WASM_PANIC_STASH_KEY]: { location: 'x.rs:1:1', at: NaN } };
    expect(takeWasmPanicStash(realmNaN)).toBeUndefined();
    const realmInf: Record<string, unknown> = { [WASM_PANIC_STASH_KEY]: { location: 'x.rs:1:1', at: Infinity } };
    expect(takeWasmPanicStash(realmInf)).toBeUndefined();
  });

  it('rejects a future at, which would otherwise pass the TTL gate trivially', () => {
    const realm: Record<string, unknown> = {
      [WASM_PANIC_STASH_KEY]: { location: 'x.rs:1:1', at: Date.now() + 60_000 },
    };
    expect(takeWasmPanicStash(realm)).toBeUndefined();
  });
});

describe('restashWasmPanicLocation', () => {
  it('re-plants a valid location/at pair on the target realm for a trap-shaped error message', () => {
    const realm: Record<string, unknown> = {};
    restashWasmPanicLocation(realm, 'geometry/src/mesh_weld.rs:412:9', 1000, 'unreachable');
    expect(realm[WASM_PANIC_STASH_KEY]).toEqual({ location: 'geometry/src/mesh_weld.rs:412:9', at: 1000 });
  });

  it('no-ops when location or at is missing/malformed', () => {
    const realm: Record<string, unknown> = {};
    restashWasmPanicLocation(realm, undefined, undefined, 'unreachable');
    expect(realm[WASM_PANIC_STASH_KEY]).toBeUndefined();
    restashWasmPanicLocation(realm, 42, 1000, 'unreachable');
    expect(realm[WASM_PANIC_STASH_KEY]).toBeUndefined();
    restashWasmPanicLocation(realm, 'x.rs:1:1', 'not-a-number', 'unreachable');
    expect(realm[WASM_PANIC_STASH_KEY]).toBeUndefined();
  });

  it('never clobbers an existing, unconsumed stash', () => {
    const realm: Record<string, unknown> = {
      [WASM_PANIC_STASH_KEY]: { location: 'already/here.rs:1:1', at: 500 },
    };
    restashWasmPanicLocation(realm, 'new/one.rs:2:2', 900, 'unreachable');
    expect(realm[WASM_PANIC_STASH_KEY]).toEqual({ location: 'already/here.rs:1:1', at: 500 });
  });

  it('does not re-plant when the error message is not trap-shaped, so a stale stash from an ' +
    'earlier suppressed panic cannot ride out on an ordinary worker error', () => {
    const realm: Record<string, unknown> = {};
    restashWasmPanicLocation(
      realm,
      'geometry/src/mesh_weld.rs:412:9',
      1000,
      'stream-end received before stream-start',
    );
    expect(realm[WASM_PANIC_STASH_KEY]).toBeUndefined();
  });
});
