/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #3790: the entity-index handoff must carry the pre-pass's
 * malformed-record stop, on BOTH branches that can produce one.
 *
 * `onEntityIndex` is what the viewer wires to `WorkerParser.setEntityIndex`,
 * and the parser worker builds the whole model from those columns without
 * scanning. When a scan stopped at an unterminated string or comment, every
 * record from that byte on is absent from `ids` by construction -- so the flag
 * is the only evidence that reaches the parser at all. Drop it and the viewer
 * shows a model missing its tail and reports the load as clean, which is the
 * exact silence #3695 removed from the paths that do their own scanning.
 *
 * Sibling of `entity-index-oversized-count.test.ts`, which pins the same wiring
 * for the #3395 refusal count.
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
  // awaits worker completion that these fake workers never signal.
  void gen.return?.(undefined as never).catch(() => undefined);
}

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

describe('entity-index handoff and the #3790 malformed-record stop', () => {
  it('forwards the serial pre-pass’s malformedRecordCount to onEntityIndex', async () => {
    const seen: (number | undefined)[] = [];
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
                oversizedIdCount: 0,
                malformedRecordCount: 1,
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
      onEntityIndex: (_ids, _starts, _lengths, _oversizedIdCount, malformedRecordCount) => {
        seen.push(malformedRecordCount);
      },
    });
    await drainOrTimeout(gen, 2_000);

    expect(seen).toEqual([1]);
  });

  /**
   * Drive the sharded branch with hand-built shard columns and return the
   * `malformedRecordCount` the host delivered to `onEntityIndex`.
   *
   * Shard 0 owns `[0, 100)`; shard 1's retained region therefore begins at byte
   * 100 when shard 0 hands off there. A stop below 100 in shard 1 is one its
   * speculative prefix invented out of bytes shard 0 already covered.
   */
  async function deliveredCount(
    shard0: { handoff: number; malformedStart?: number },
    shard1: { handoff: number; malformedStart?: number },
  ): Promise<(number | undefined)[]> {
    const seen: (number | undefined)[] = [];
    // >= 8 MB of SAB and >= 2 workers arms the shard scan.
    const shared = new SharedArrayBuffer(8 * 1024 * 1024);
    const shards = [
      { ids: new Uint32Array([1]), starts: new Uint32Array([0]), ...shard0 },
      { ids: new Uint32Array([7]), starts: new Uint32Array([100]), ...shard1 },
    ];

    installWorkers((self, msg) => {
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
              oversizedIdStarts: new Uint32Array(0),
              malformedStart: shard.malformedStart,
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
        onEntityIndex: (_ids, _starts, _lengths, _oversizedIdCount, malformedRecordCount) => {
          // Pushed RAW: `?? -1` here would hide the very distinction under
          // test, which is that "nothing reported" survives the delivery as
          // undefined rather than arriving as a fabricated 0.
          seen.push(malformedRecordCount);
        },
      },
    );
    await drainOrTimeout(gen, 2_000);
    return seen;
  }

  it('reports the stitch’s attributed stop, not a per-shard OR', async () => {
    // Shard 1's stop at byte 40 sits inside the range shard 0 owns: an artefact
    // of starting mid-quote, on a file that is fine. Summing or OR-ing the
    // shards would warn about it.
    expect(await deliveredCount({ handoff: 100 }, { handoff: -1, malformedStart: 40 }))
      .toEqual([undefined]);
  });

  it('reports a real stop the sharded scan hit', async () => {
    // Shard 0 is authoritative from byte 0, so its stop is one a serial scan
    // makes too -- and it is exactly the case that used to reach the viewer as
    // a short model with no signal at all.
    expect(await deliveredCount({ handoff: -1, malformedStart: 60 }, { handoff: -1 })).toEqual([1]);
  });

  it('delivers undefined, not 0, when no shard reported a stop', async () => {
    // The state on main today (#3699 unlanded): every shard omits the offset.
    // Delivering 0 would tell the parser the pre-pass verified a clean scan,
    // which no producer has said and none can say yet.
    expect(await deliveredCount({ handoff: 100 }, { handoff: -1 })).toEqual([undefined]);
  });
});
