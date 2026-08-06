/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';

import { installInProcessOverlayWorker } from './overlay-worker-shim.js';
import { parseOverlayLines, parseSymbolicFlat } from '@/lib/overlay-parse/index.js';

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
    // Dispatched in the same tick: all three are in flight before any settles.
    const [grid, alignment, symbolic] = await Promise.all([
      parseOverlayLines('grid-lines', new Uint8Array([1])),
      parseOverlayLines('alignment-lines', new Uint8Array([1])),
      parseSymbolicFlat(new Uint8Array([1])),
    ]);
    assert.ok(grid instanceof Float32Array);
    assert.ok(alignment instanceof Float32Array);
    assert.ok(symbolic && Array.isArray(symbolic.typeNames));

    // The load-bearing assertion. The input is garbage, so every result is
    // empty either way — and the client ALSO resolves empty when a reply is
    // lost. Only the worker's own reply log distinguishes "three jobs
    // answered" from "three jobs silently fell back".
    assert.equal(
      shim.repliedIds().length, 3,
      `worker replied for ${shim.repliedIds().length} of 3 jobs; the rest hit the client fallback`,
    );
    assert.equal(new Set(shim.repliedIds()).size, 3, 'each job needs its own id');
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
