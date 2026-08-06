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

let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

describe('in-process overlay worker shim', () => {
  it('routes replies correctly when jobs overlap', async () => {
    restore = installInProcessOverlayWorker();
    // Dispatched in the same tick: both are in flight before either settles.
    const [grid, alignment, symbolic] = await Promise.all([
      parseOverlayLines('grid-lines', new Uint8Array([1])),
      parseOverlayLines('alignment-lines', new Uint8Array([1])),
      parseSymbolicFlat(new Uint8Array([1])),
    ]);
    // Garbage input, so the values are empty — what matters is that all three
    // SETTLED. A lost reply would hang until the client's deadline instead.
    assert.ok(grid instanceof Float32Array, 'grid job must settle');
    assert.ok(alignment instanceof Float32Array, 'alignment job must settle');
    assert.ok(symbolic && Array.isArray(symbolic.typeNames), 'symbolic job must settle');
  });

  it('restores the previous Worker wiring on teardown', async () => {
    const before = (globalThis as { self?: unknown }).self;
    const undo = installInProcessOverlayWorker();
    undo();
    assert.equal((globalThis as { self?: unknown }).self, before);
    // With the shim gone and Node having no Worker, the client must resolve
    // empty rather than throw.
    assert.equal((await parseOverlayLines('grid-lines', new Uint8Array([1]))).length, 0);
  });
});
