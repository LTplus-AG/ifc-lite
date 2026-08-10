/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processParallel } from './geometry-parallel.js';
import { CoordinateHandler } from './coordinate-handler.js';
// The streaming event union is declared and exported by index.ts, not types.ts
// (geometry-parallel.ts imports it from there too).
import type { StreamingGeometryEvent } from './index.js';

/**
 * Minimal `Worker` stand-in. `postMessage` is caller-configurable per
 * instance so a test can make ONE message type fail while every other
 * message the real pipeline sends (init / set-* / stream-start) still
 * "arrives" (recorded, and forwarded to a scripted `onmessage` reply where
 * the fixture below wires one).
 */
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

/**
 * Drain the generator, failing fast instead of hanging — same rationale as
 * `geometry-native.test.ts`'s `drainWithDeadline`: the failure mode under
 * test for a per-worker completion barrier that never closes IS a hang, so a
 * bare `await`/`for await` would stall the suite rather than fail it.
 */
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
 * Wires a `globalThis.Worker` that drives exactly the sequence
 * `processParallel` needs to reach `sendStreamEnd()` with ONE process worker
 * (`workerCountOverride: 1`, which also keeps the SPIKE shard-scan path off —
 * it requires `workers.length >= 2`):
 *
 *  - worker #0 (the process pool, created first): its `postMessage` throws
 *    on `{ type: 'stream-end' }` iff `streamEndThrows` is true — reproducing
 *    the postMessage catch inside `sendStreamEnd` at geometry-parallel.ts.
 *    When it does NOT throw, it replies with the same `{ type: 'complete' }`
 *    a real worker only ever sends from `emitSessionEnd`, which
 *    `geometry.worker.ts` calls exclusively from its `stream-end` handler —
 *    so in this fixture a worker "completes" if and only if `stream-end`
 *    actually reached it.
 *  - worker #1 (the pre-pass worker, created second): replies to
 *    `prepass-streaming` with a synthesized `meta` event (arms
 *    `streamStartSentToWorkers`) immediately followed by a `complete` event
 *    (`totalJobs: 0`), which drives `onPrepassComplete` -> `sendStreamEnd()`
 *    with no queued chunks and no sharding (single worker).
 */
function installFakeWorkers(streamEndThrows: boolean): void {
  (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function (
    this: unknown,
  ) {
    const index = createdWorkers.length;
    const worker = new FakeWorker((self, msg) => {
      const m = msg as { type?: string };
      if (index === 0 && m.type === 'stream-end') {
        if (streamEndThrows) {
          throw new Error('port is in a state we did not expect');
        }
        queueMicrotask(() => {
          self.onmessage?.({ data: { type: 'complete', totalMeshes: 0 } });
        });
        return;
      }
      if (index === 1 && m.type === 'prepass-streaming') {
        // Synthesize meta then complete on the next microtask — real
        // `Worker#postMessage` never delivers synchronously within the
        // caller's own call stack, and `processParallel` relies on that:
        // module-scope `let`s declared AFTER this dispatch site (e.g.
        // `prepassCompleteSeen`) are still in their temporal dead zone at
        // the point `startPrepass` posts this message.
        queueMicrotask(() => {
          self.onmessage?.({
            data: {
              type: 'prepass-stream',
              event: {
                type: 'meta',
                unitScale: 1,
                rtcOffset: new Float64Array([0, 0, 0]),
                needsShift: false,
              },
            },
          });
          self.onmessage?.({
            data: { type: 'prepass-stream', event: { type: 'complete', totalJobs: 0 } },
          });
        });
      }
    });
    createdWorkers.push(worker);
    return worker;
  }) as unknown as typeof Worker;
}

function run(streamEndThrows: boolean) {
  installFakeWorkers(streamEndThrows);
  return processParallel(
    new Uint8Array(16),
    new CoordinateHandler(),
    undefined,
    undefined,
    { workerCountOverride: 1 },
  );
}

describe('processParallel when stream-end postMessage fails for a worker', () => {
  it('surfaces a load failure instead of hanging when stream-end cannot reach a worker', async () => {
    // Pre-fix: with only the warn-and-continue catch in `sendStreamEnd`,
    // worker #0 never receives `stream-end`, so it never posts its own
    // `complete` (geometry.worker.ts posts `complete` ONLY from
    // `emitSessionEnd`, called ONLY from the `stream-end` handler).
    // `workersCompleted` for worker #0 never reaches 1, so the barrier at
    // geometry-parallel.ts's `workersCompleted >= workers.length` never
    // closes and the generator parks forever on `resolveWaiting` — this
    // assertion times out (RED) until the fix tracks the failed delivery
    // and turns it into a thrown load error instead.
    const gen = run(true);
    await expect(drainWithDeadline(gen, 1_000)).rejects.toThrow(
      /stream-end/i,
    );
  });

  it('still completes normally when stream-end reaches every worker', async () => {
    const gen = run(false);
    const events = await drainWithDeadline(gen, 1_000);
    expect(events.some((e) => e.type === 'complete')).toBe(true);
  });
});
