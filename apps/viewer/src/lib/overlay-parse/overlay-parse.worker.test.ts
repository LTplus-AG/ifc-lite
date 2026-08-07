/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { contiguousSourceBytes } from '@ifc-lite/parser';

/**
 * The worker's contract with its client is: ALWAYS post exactly one reply,
 * and never reject.
 *
 * Silence is the one outcome the client cannot recover from cheaply — it has
 * to sit on the full 120s deadline before giving up. Before #2183's follow-up
 * the `GeometryProcessor` was constructed OUTSIDE the try, so a construction
 * failure escaped into the queue's `.catch()` and posted nothing at all.
 *
 * Under Node there is no WASM runtime, so the processor fails to come up on
 * its own. That is not a contrived stub — it is exactly the class of early
 * failure (asset unavailable, instantiate rejected) this contract exists for,
 * and it reaches the same path.
 */

const posted: unknown[] = [];
let handle: typeof import('./overlay-parse.worker.js').handle;
let setFactory: typeof import('./overlay-parse.worker.js').__setProcessorFactoryForTest;

beforeEach(async () => {
  posted.length = 0;
  // The module guards its `self.onmessage` registration on being in a real
  // worker scope, which is what makes it importable here at all.
  (globalThis as { self?: unknown }).self = {
    postMessage: (msg: unknown) => { posted.push(msg); },
  };
  const mod = await import(`./overlay-parse.worker.js?t=${Date.now()}${Math.random()}`);
  handle = mod.handle;
  setFactory = mod.__setProcessorFactoryForTest;
});

afterEach(() => {
  setFactory?.(null);
  delete (globalThis as { self?: unknown }).self;
});

function event(kind: 'grid-lines' | 'alignment-lines' = 'grid-lines'): MessageEvent<never> {
  // A real envelope, not a hand-rolled one: the worker rebuilds through
  // sourceBytesFromTransferable, so a stale shape here would test a message
  // the client can no longer send.
  const source = contiguousSourceBytes(new Uint8Array([1])).toTransferable();
  return { data: { id: 7, kind, source } } as unknown as MessageEvent<never>;
}

describe('overlay-parse worker handle', () => {
  it('is importable outside a worker scope (registration is guarded)', () => {
    assert.equal(typeof handle, 'function');
  });

  // THE regression: the processor used to be constructed outside the try, so
  // a construction failure escaped into the queue's catch and posted nothing.
  it('posts an error reply when the processor cannot be CONSTRUCTED', async () => {
    setFactory(() => { throw new Error('wasm asset unavailable'); });
    await handle(event());
    assert.equal(posted.length, 1, 'silence costs the client its full 120s deadline');
    const reply = posted[0] as { id: number; ok: boolean; error: string };
    assert.equal(reply.id, 7, 'the reply must carry the id so the client can route it');
    assert.equal(reply.ok, false);
    assert.match(reply.error, /wasm asset unavailable/);
  });

  it('never rejects on a construction failure, so the queue is not poisoned', async () => {
    setFactory(() => { throw new Error('boom'); });
    await assert.doesNotReject(() => handle(event()));
    await assert.doesNotReject(() => handle(event('alignment-lines')));
    assert.equal(posted.length, 2, 'a second job still gets its own reply');
  });

  it('posts exactly one reply on the real path', async () => {
    await handle(event());
    assert.equal(posted.length, 1);
    assert.equal((posted[0] as { id: number }).id, 7);
  });
});
