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
 * event, the sharded path ATTRIBUTES per-shard refusal offsets against the
 * boundary the stitch validated. The sharded one is the canonical viewer path
 * (>= 8 MB, >= 2 workers), and the one that can lie in both directions —
 * summing the shards reports refusals that a discarded speculative prefix
 * invented, on a file that declares none (#3430).
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

  /**
   * Drive the sharded branch with hand-built shard columns and return the
   * `oversizedIdCount` the host delivered to `onEntityIndex`.
   *
   * Shard 0 owns `[0, 100)` and hands off at 100; shard 1's retained region
   * therefore begins at byte 100. An offset below 100 in shard 1's list is a
   * refusal its speculative prefix invented out of bytes shard 0 already
   * covered — exactly the case a per-shard sum gets wrong.
   */
  async function deliveredCount(
    shard0Refusals: Uint32Array,
    shard1Refusals: Uint32Array,
  ): Promise<number[]> {
    const seen: number[] = [];
    // >= 8 MB of SAB and >= 2 workers arms the shard scan.
    const shared = new SharedArrayBuffer(8 * 1024 * 1024);
    const shards = [
      {
        ids: new Uint32Array([1]),
        starts: new Uint32Array([0]),
        handoff: 100,
        oversizedIdStarts: shard0Refusals,
      },
      {
        ids: new Uint32Array([7]),
        starts: new Uint32Array([100]),
        handoff: -1,
        oversizedIdStarts: shard1Refusals,
      },
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
              oversizedIdStarts: shard.oversizedIdStarts,
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
    return seen;
  }

  it('reports nothing when every shard refusal came from a dropped speculative prefix', async () => {
    // Shard 1 started mid-file and refused two records at bytes 40 and 60 —
    // inside the range shard 0 owns, so they are text its misaligned scan
    // parsed out of a quoted value, not records the file declares. The stitch
    // drops the records it found there; it must drop these too, or a file with
    // NOTHING oversized in it warns the user that it loaded short (#3430).
    expect(await deliveredCount(new Uint32Array(), new Uint32Array([40, 60]))).toEqual([0]);
  });

  it('counts a refusal inside each shard’s retained region exactly once', async () => {
    // Shard 0 refused a real record at byte 50 (its whole range is retained).
    // Shard 1 saw that same byte 50 again while speculating, plus a real one
    // at 130 inside the region it actually owns. Total must be 2, not 3: the
    // duplicate is dropped, the real ones both survive.
    expect(
      await deliveredCount(new Uint32Array([50]), new Uint32Array([50, 130])),
    ).toEqual([2]);
  });
});
