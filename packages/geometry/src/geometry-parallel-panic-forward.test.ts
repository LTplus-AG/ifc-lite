/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2527 follow-up: a Rust panic inside a geometry PROCESS worker (as opposed
 * to the main thread) stashes its source location on the WORKER's own
 * global, which the main thread's `attachWasmPanicLocation` gate
 * (analytics-scrub.ts) can never see across the realm boundary — so the
 * "Geometry worker error: unreachable" traps #2527's own report named as a
 * residual arrived exactly as untriaged as before the fix.
 *
 * This pins that `processParallel` (geometry-parallel.ts) reads the
 * `wasmPanicLocation`/`wasmPanicAt` fields the worker now forwards on its
 * `{type:'error'}` message and re-plants them on `globalThis` under the same
 * `__ifclite_wasm_panic` key the main-thread trap path already uses — so the
 * EXISTING #2527 gate picks a worker trap up unmodified.
 *
 * Fixture pattern mirrors `geometry-parallel-stream-end.test.ts`'s FakeWorker.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processParallel } from './geometry-parallel.js';
import { CoordinateHandler } from './coordinate-handler.js';
import { WASM_PANIC_STASH_KEY } from './wasm-panic-forward.js';
import type { StreamingGeometryEvent } from './index.js';

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

function globalStash(): unknown {
  return (globalThis as Record<string, unknown>)[WASM_PANIC_STASH_KEY];
}

beforeEach(() => {
  createdWorkers = [];
  originalWorker = (globalThis as Record<string, unknown>).Worker;
  delete (globalThis as Record<string, unknown>)[WASM_PANIC_STASH_KEY];
});

afterEach(() => {
  (globalThis as Record<string, unknown>).Worker = originalWorker;
  delete (globalThis as Record<string, unknown>)[WASM_PANIC_STASH_KEY];
  vi.restoreAllMocks();
});

async function drainWithDeadline(
  gen: AsyncGenerator<StreamingGeometryEvent>,
  ms = 500,
): Promise<StreamingGeometryEvent[]> {
  const events: StreamingGeometryEvent[] = [];
  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('TIMED_OUT: generator never settled')), ms).unref?.();
  });
  const drain = (async () => {
    for await (const event of gen) events.push(event);
    return events;
  })();
  return Promise.race([drain, deadline]);
}

/**
 * Wires a `globalThis.Worker` where process worker #0 (created first, since
 * `workerCountOverride: 1` spawns exactly one) replies to its `init` message
 * with a `{type:'error'}` carrying a wasm panic location — reproducing a
 * worker-realm trap during WASM instantiation. Worker #1 (the pre-pass
 * worker, created second) is left unscripted: `workerError` is already set
 * by the time the drain loop's first iteration checks it, so the pipeline
 * never needs a pre-pass reply.
 */
function installFakeWorkers(
  panicLocation: string | undefined,
  panicAt: number | undefined,
  message = 'unreachable',
): void {
  (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function (
    this: unknown,
  ) {
    const index = createdWorkers.length;
    const worker = new FakeWorker((self, msg) => {
      const m = msg as { type?: string };
      if (index === 0 && m.type === 'init') {
        self.onmessage?.({
          data: {
            type: 'error',
            message,
            ...(panicLocation !== undefined ? { wasmPanicLocation: panicLocation } : {}),
            ...(panicAt !== undefined ? { wasmPanicAt: panicAt } : {}),
          },
        });
      }
    });
    createdWorkers.push(worker);
    return worker;
  }) as unknown as typeof Worker;
}

function run(panicLocation: string | undefined, panicAt: number | undefined, message?: string) {
  installFakeWorkers(panicLocation, panicAt, message);
  return processParallel(
    new Uint8Array(16),
    new CoordinateHandler(),
    undefined,
    undefined,
    { workerCountOverride: 1 },
  );
}

describe('processParallel forwards a geometry worker realm panic location', () => {
  it('re-plants the worker-forwarded location on globalThis before the load fails', async () => {
    const at = Date.now();
    const gen = run('geometry/src/mesh_weld.rs:412:9', at);
    await expect(drainWithDeadline(gen, 1_000)).rejects.toThrow(/Geometry worker error: unreachable/);
    expect(globalStash()).toEqual({ location: 'geometry/src/mesh_weld.rs:412:9', at });
  });

  // RED before the forwarding existed: a worker error with NO panic fields
  // (the ordinary, non-trap failure shape every existing test used) must
  // never plant anything — proves the new code path is additive, not a
  // blanket stash on every worker error.
  it('leaves globalThis untouched when the worker error carries no panic location', async () => {
    const gen = run(undefined, undefined);
    await expect(drainWithDeadline(gen, 1_000)).rejects.toThrow(/Geometry worker error: unreachable/);
    expect(globalStash()).toBeUndefined();
  });

  it('does not clobber an existing, unconsumed stash (a genuine main-thread trap wins)', async () => {
    (globalThis as Record<string, unknown>)[WASM_PANIC_STASH_KEY] = {
      location: 'already/pending.rs:1:1',
      at: Date.now(),
    };
    const gen = run('geometry/src/mesh_weld.rs:412:9', Date.now());
    await expect(drainWithDeadline(gen, 1_000)).rejects.toThrow(/Geometry worker error: unreachable/);
    expect(globalStash()).toEqual({ location: 'already/pending.rs:1:1', at: expect.any(Number) });
  });

  // A worker forwards wasmPanicLocation/wasmPanicAt on ANY {type:'error'}
  // message (takeWasmPanicStash consumes regardless of shape validity), so a
  // stash left over from an earlier, suppressed panic can ride out on an
  // ordinary, non-trap worker error. Re-planting it unconditionally would let
  // it sit on globalThis until an unrelated trap-shaped exception consumed
  // it, mislabeling that trap. The trap-shape gate on restashWasmPanicLocation
  // must block this through the real processParallel path, not just at the
  // wasm-panic-forward.ts unit level.
  it('does not re-plant a location forwarded alongside a non-trap worker error', async () => {
    const gen = run(
      'geometry/src/mesh_weld.rs:412:9',
      Date.now(),
      'stream-end received before stream-start',
    );
    await expect(drainWithDeadline(gen, 1_000)).rejects.toThrow(
      /Geometry worker error: stream-end received before stream-start/,
    );
    expect(globalStash()).toBeUndefined();
  });
});
