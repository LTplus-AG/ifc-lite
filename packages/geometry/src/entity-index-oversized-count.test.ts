/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3395: the entity-index handoff must carry the pre-pass's refusal
 * count, on BOTH branches that produce one.
 *
 * `onEntityIndex` is what the viewer wires to `WorkerParser.setEntityIndex`,
 * and the parser worker builds the whole model from those columns without
 * scanning. A record the Rust scanner refused for an express id above `u32`
 * is absent from `ids` by construction, so the count is the only evidence
 * that reaches the parser at all — drop it and the load reports clean while
 * being short by exactly that many entities.
 *
 * Both branches are covered because they compute the number differently and
 * fail independently: the serial pre-pass reads it off its `entity-index`
 * event, the sharded path sums the per-shard counts. The sharded one is the
 * canonical viewer path (>= 8 MB, >= 2 workers).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoordinateHandler } from './coordinate-handler.js';
import { processParallel } from './geometry-parallel.js';
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

beforeEach(() => {
  createdWorkers = [];
  originalWorker = (globalThis as Record<string, unknown>).Worker;
});

afterEach(() => {
  (globalThis as Record<string, unknown>).Worker = originalWorker;
  vi.restoreAllMocks();
});

/** Drain, failing fast rather than hanging (same rationale as the sibling tests). */
async function drainOrTimeout(
  gen: AsyncGenerator<StreamingGeometryEvent>,
  ms: number,
): Promise<void> {
  const deadline = new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
  const drain = (async () => {
    for await (const _event of gen) {
      /* the assertions are on the entity-index callback, not the mesh stream */
    }
  })();
  await Promise.race([drain.catch(() => undefined), deadline]);
  // Do NOT await `gen.return()` here: the generator's teardown `finally`
  // awaits worker completion that these fake workers never signal, so the
  // await would re-park on the very stall the deadline just escaped.
  void gen.return?.(undefined as never).catch(() => undefined);
}

/** What the pre-pass hands over: two records survived, some were refused. */
const IDS = new Uint32Array([1, 7]);
const STARTS = new Uint32Array([0, 100]);
const LENGTHS = new Uint32Array([10, 10]);

function installWorkers(
  onPost: (self: FakeWorker, msg: unknown, index: number) => void,
): void {
  (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function (
    this: unknown,
  ) {
    const index = createdWorkers.length;
    const worker = new FakeWorker((self, msg) => onPost(self, msg, index));
    createdWorkers.push(worker);
    return worker;
  }) as unknown as typeof Worker;
}

describe('entity-index handoff and the #3395 refusal count', () => {
  it('forwards the serial pre-pass’s oversizedIdCount to onEntityIndex', async () => {
    const seen: number[] = [];
    // One pool worker keeps the sharded branch off (it needs >= 2), so this
    // exercises the pre-pass `entity-index` event and nothing else.
    installWorkers((self, msg, index) => {
      const m = msg as { type?: string };
      if (index === 1 && m.type === 'prepass-streaming') {
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
            data: {
              type: 'prepass-stream',
              event: {
                type: 'entity-index',
                ids: IDS,
                starts: STARTS,
                lengths: LENGTHS,
                oversizedIdCount: 2,
              },
            },
          });
          self.onmessage?.({
            data: { type: 'prepass-stream', event: { type: 'complete', totalJobs: 0 } },
          });
        });
      }
    });

    const gen = processParallel(new Uint8Array(16), new CoordinateHandler(), undefined, undefined, {
      workerCountOverride: 1,
      onEntityIndex: (_ids, _starts, _lengths, oversizedIdCount) => {
        seen.push(oversizedIdCount ?? -1);
      },
    });
    await drainOrTimeout(gen, 2_000);

    expect(seen).toEqual([2]);
  });

  it('sums the per-shard counts on the sharded path the viewer actually takes', async () => {
    const seen: number[] = [];
    // >= 8 MB of SAB and >= 2 workers arms the shard scan. Each shard reports
    // its own refusals, so the host has to add them up: keeping only one
    // shard's count would under-report on every file big enough to shard,
    // which is every file that reaches this branch at all.
    const shared = new SharedArrayBuffer(8 * 1024 * 1024);
    const shards = [
      { ids: new Uint32Array([1]), starts: new Uint32Array([0]), handoff: 100, oversizedIdCount: 2 },
      { ids: new Uint32Array([7]), starts: new Uint32Array([100]), handoff: -1, oversizedIdCount: 3 },
    ];

    installWorkers((self, msg, index) => {
      const m = msg as { type?: string; shardIndex?: number };
      if (m.type === 'scan-shard') {
        const shard = shards[m.shardIndex ?? 0];
        queueMicrotask(() => {
          self.onmessage?.({
            data: {
              type: 'shard-result',
              shardIndex: m.shardIndex,
              ids: shard.ids,
              starts: shard.starts,
              lengths: new Uint32Array([10]),
              classes: new Uint8Array([0]),
              handoff: shard.handoff,
              oversizedIdCount: shard.oversizedIdCount,
            },
          });
        });
      }
    });

    const gen = processParallel(
      new Uint8Array(shared),
      new CoordinateHandler(),
      undefined,
      shared,
      {
        workerCountOverride: 2,
        onEntityIndex: (_ids, _starts, _lengths, oversizedIdCount) => {
          seen.push(oversizedIdCount ?? -1);
        },
      },
    );
    await drainOrTimeout(gen, 2_000);

    expect(seen).toEqual([5]);
  });
});
