/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';

import { installInProcessOverlayWorker } from './overlay-worker-shim.js';
import {
  parseOverlayLines,
  parseProfilesFlat,
  parseSymbolicFlat,
} from '@/lib/overlay-parse/index.js';

/**
 * The shim exists so end-to-end hook tests are not silently vacuous. If it
 * loses a reply the tests it supports go quietly empty, which is precisely
 * the failure mode it was written to prevent — so it needs its own cover.
 *
 * The specific hazard: the overlay client dispatches jobs concurrently, and
 * `handle()` posts through `self.postMessage`. Swapping `self` per call means
 * whichever job finishes first restores it and the other can never reply.
 */

import type { OverlayShimHandle } from './overlay-worker-shim.js';

let shim: OverlayShimHandle | undefined;

afterEach(() => {
  shim?.restore();
  shim = undefined;
});

describe('in-process overlay worker shim', () => {
  it('routes replies correctly when jobs overlap', async () => {
    shim = installInProcessOverlayWorker();
    // Dispatched in the same tick: all four are in flight before any settles.
    const [grid, alignment, symbolic, profiles] = await Promise.all([
      parseOverlayLines('grid-lines', new Uint8Array([1])),
      parseOverlayLines('alignment-lines', new Uint8Array([1])),
      parseSymbolicFlat(new Uint8Array([1])),
      parseProfilesFlat(new Uint8Array([1])),
    ]);
    assert.ok(grid instanceof Float32Array);
    assert.ok(alignment instanceof Float32Array);
    assert.ok(symbolic && Array.isArray(symbolic.typeNames));
    assert.ok(profiles && profiles.expressId instanceof Uint32Array);

    // The load-bearing assertion. The input is garbage, so every result is
    // empty either way — and the client ALSO resolves empty when a reply is
    // lost. Only the worker's own reply log distinguishes "four jobs
    // answered" from "four jobs silently fell back".
    assert.equal(
      shim.repliedIds().length, 4,
      `worker replied for ${shim.repliedIds().length} of 4 jobs; the rest hit the client fallback`,
    );
    assert.equal(new Set(shim.repliedIds()).size, 4, 'each job needs its own id');
  });

  // Reported in review: restore() used to reset to the default factory, so a
  // nested install silently disabled the outer shim on teardown.
  it('restores the OUTER shim, not the default, when nested', async () => {
    const outer = installInProcessOverlayWorker();
    try {
      const inner = installInProcessOverlayWorker();
      inner.restore();
    // The outer shim must still be serving: with it disabled, Node has no
    // Worker and this would resolve empty without the worker ever replying.
      const before = outer.repliedIds().length;
      await parseOverlayLines('grid-lines', new Uint8Array([1]));
      assert.ok(
        outer.repliedIds().length > before,
        'the outer shim stopped serving, so restore() reset to the default',
      );
    } finally {
      // A failed assertion above must not leave the outer shim installed for
      // every later test in this file.
      outer.restore();
    }
  });

  it('restores the previous Worker wiring on teardown', async () => {
    const before = (globalThis as { self?: unknown }).self;
    installInProcessOverlayWorker().restore();
    assert.equal((globalThis as { self?: unknown }).self, before);
    // With the shim gone and Node having no Worker, the client must resolve
    // empty rather than throw.
    assert.equal((await parseOverlayLines('grid-lines', new Uint8Array([1]))).length, 0);
  });
});
