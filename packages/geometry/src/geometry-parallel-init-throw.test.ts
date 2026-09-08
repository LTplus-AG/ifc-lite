/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `processParallel` spawns its process-worker pool and sends each one an
 * `init` (plus `set-*`) message in a loop that ran BEFORE the function's
 * try/finally — the finally at the bottom is what terminates `workers` and
 * `prepassWorker` on any exit path, but a worker pushed to `workers` during
 * that pre-try loop was invisible to it if `postMessage` threw partway
 * through (e.g. a `wasmModule` structured-clone failure, the same class of
 * error `dispatchJobsChunkInternal` already guards against further down).
 * Same acquire-then-fail-uncleaned shape as the two confirmed leaks in
 * `collab/session.ts` and `collab-server/room-manager.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processParallel } from './geometry-parallel.js';
import { CoordinateHandler } from './coordinate-handler.js';

class FakeWorker {
  postMessage: (msg: unknown) => void;
  terminate = vi.fn();
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  constructor(onPost: (self: FakeWorker, msg: unknown) => void) {
    this.postMessage = vi.fn((msg: unknown) => onPost(this, msg));
  }
}

let createdWorkers: FakeWorker[];
let originalWorker: unknown;

beforeEach(() => {
  createdWorkers = [];
  originalWorker = (globalThis as Record<string, unknown>).Worker;
});

afterEach(() => {
  (globalThis as Record<string, unknown>).Worker = originalWorker;
  vi.restoreAllMocks();
});

describe('processParallel terminates already-spawned workers when the init loop throws', () => {
  it('calls terminate() on a worker whose "init" postMessage throws before the try/finally', async () => {
    (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function (
      this: unknown,
    ) {
      const index = createdWorkers.length;
      const worker = new FakeWorker((_self, msg) => {
        const m = msg as { type?: string };
        if (index === 0 && m.type === 'init') {
          throw new Error('forced clone failure (simulated)');
        }
      });
      createdWorkers.push(worker);
      return worker;
    }) as unknown as typeof Worker;

    const gen = processParallel(
      new Uint8Array(16),
      new CoordinateHandler(),
      undefined,
      undefined,
      { workerCountOverride: 1 },
    );

    let rejected: unknown;
    try {
      // The generator yields `start`/`model-open` before reaching the
      // workers[] init loop; drain until it throws.
      for (let i = 0; i < 10; i++) {
        const result = await gen.next();
        if (result.done) break;
      }
    } catch (err) {
      rejected = err;
    }

    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toMatch(/forced clone failure/);
    expect(createdWorkers.length).toBe(1);
    expect(createdWorkers[0].terminate).toHaveBeenCalled();
  });
});
