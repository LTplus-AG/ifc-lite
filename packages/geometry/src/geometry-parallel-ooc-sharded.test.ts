/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Out-of-core ingest keeps the sharded pre-pass (its first frame waited on the serial scan before): the shard scans
 * copy windows, never the file, into the workers (`windowed`, no source session); the sharded pre-pass emits the
 * sparse facts and resolves styles itself, so no worker is sent a style slice or the finalize call, both of which
 * read the whole file inside that worker's wasm. The workers look ids up by binary search, so they get the pre-pass's
 * sorted index, never the stitch (file order).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processParallel } from './geometry-parallel.js';
import { CoordinateHandler } from './coordinate-handler.js';

interface Message { type: string; [key: string]: unknown }

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminate = vi.fn();
  received: Message[] = [];
  constructor(private handle: (worker: FakeWorker, message: Message) => void) {}
  postMessage(message: Message) {
    this.received.push(message);
    this.handle(this, message);
  }
  reply(data: unknown) { this.onmessage?.({ data }); }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (globalThis as { __IFC_LITE_OOC_STATS__?: unknown }).__IFC_LITE_OOC_STATS__;
});

const BYTES = 27 * 1024 * 1024;
const HANDOFF = BYTES / 2 + 100;

const styles = () => ({
  type: 'styles', styleIds: new Uint32Array(), styleColors: new Uint8Array(), voidKeys: new Uint32Array(),
  voidCounts: new Uint32Array(), voidValues: new Uint32Array(),
});

/** One two-worker load whose shard scans stitch to two records written out of id order; no jobs. */
async function load(outOfCore: boolean, refuseWindow = false) {
  const created: FakeWorker[] = [];
  vi.stubGlobal('Worker', vi.fn().mockImplementation(function () {
    const worker = new FakeWorker((self, message) => {
      const emit = (event: Record<string, unknown>) => self.reply({ type: 'prepass-stream', event });
      if (message.type === 'scan-shard') {
        const first = message.shardIndex === 0;
        queueMicrotask(() => self.reply(refuseWindow && !first ? { type: 'shard-result', shardIndex: 1, windowRefused: true } : {
          type: 'shard-result', shardIndex: message.shardIndex, ids: Uint32Array.from([first ? 7 : 3]),
          starts: Uint32Array.from([first ? 0 : HANDOFF]), lengths: Uint32Array.from([4]), classes: new Uint8Array(1),
          handoff: first ? HANDOFF : -1,
        }));
      } else if (message.type === 'prepass-streaming') { // the serial pre-pass, after a refused window
        queueMicrotask(() => {
          emit({ type: 'entity-index', ids: Uint32Array.from([3, 7]), starts: Uint32Array.from([HANDOFF, 0]), lengths: Uint32Array.from([4, 4]) });
          if (message.emitSparseFacts) emit({ type: 'sparse-facts', preamble: Uint8Array.from([1]), inverseTargets: new Uint32Array(), inverseReferrers: new Uint32Array() });
          emit(styles());
          emit({ type: 'complete', totalJobs: 0 });
        });
      } else if (message.type === 'prepass-streaming-sharded') {
        queueMicrotask(() => {
          emit({ type: 'meta', unitScale: 1, rtcOffset: new Float64Array(3), needsShift: false });
          if (message.emitSparseFacts) {
            emit({ type: 'entity-index', ids: Uint32Array.from([3, 7]), starts: Uint32Array.from([HANDOFF, 0]), lengths: Uint32Array.from([4, 4]) });
            emit({ type: 'sparse-facts', preamble: Uint8Array.from([1]), inverseTargets: new Uint32Array(), inverseReferrers: new Uint32Array() });
            emit(styles());
          }
          emit({ type: 'complete', totalJobs: 0 });
        });
      } else if (message.type === 'stream-end') {
        self.reply({ type: 'complete', totalMeshes: 0 });
      }
    });
    created.push(worker);
    return worker;
  }));
  const shared = new SharedArrayBuffer(BYTES);
  const decisions: boolean[] = [];
  let failure: unknown;
  const drain = (async () => {
    try {
      for await (const _ of processParallel(new Uint8Array(shared), new CoordinateHandler(), undefined, shared,
        { workerCountOverride: 2, outOfCore, onOutOfCoreDecision: (ran) => decisions.push(ran) })) { /* drain */ }
    } catch (err) {
      failure = err;
    }
  })();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60_000);
  await drain;
  const all = created.flatMap((w) => w.received);
  return { decisions, failure, all, sent: all.map((m) => m.type) };
}

describe('out-of-core ingest on the sharded pre-pass', () => {
  it('scans windows, leaves styles to the pre-pass and meshes from sparse sources', async () => {
    const { decisions, failure, all, sent } = await load(true);
    expect(failure).toBeUndefined();
    const scans = all.filter((m) => m.type === 'scan-shard');
    expect(scans).toHaveLength(2);
    for (const scan of scans) {
      expect(scan.windowed).toBe(true);
      expect(scan.sourceSessionId, 'no worker installs the file for the stream').toBeUndefined();
    }
    expect(all.find((m) => m.type === 'prepass-streaming-sharded')?.emitSparseFacts).toBe(true);
    expect(sent).not.toContain('prepass-streaming');
    expect(sent).not.toContain('resolve-styles-shard');
    expect(sent).not.toContain('finalize-styles');
    const sources = all.filter((m) => m.type === 'set-sparse-source');
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect([...(source.indexIds as Uint32Array)], 'ascending by id').toEqual([3, 7]);
      expect([...(source.indexStarts as Uint32Array)]).toEqual([HANDOFF, 0]);
    }
    expect(sent).not.toContain('set-entity-index');
    expect(decisions).toEqual([true]);
  });

  it('takes the serial pre-pass when a shard window could not be confirmed', async () => {
    const { decisions, failure, all, sent } = await load(true, true);
    expect(failure).toBeUndefined();
    expect(sent).not.toContain('prepass-streaming-sharded');
    expect(all.find((m) => m.type === 'prepass-streaming')?.emitSparseFacts).toBe(true);
    expect(all.filter((m) => m.type === 'set-sparse-source')).toHaveLength(2);
    expect(decisions).toEqual([true]);
  });

  it('keeps the whole-file sharded scan as it was when the flag is off', async () => {
    const { all, sent } = await load(false);
    const scans = all.filter((m) => m.type === 'scan-shard');
    expect(scans).toHaveLength(2);
    for (const scan of scans) expect(scan.windowed).toBeUndefined();
    expect(all.find((m) => m.type === 'prepass-streaming-sharded')?.emitSparseFacts).toBeUndefined();
    expect(sent).toContain('resolve-styles-shard');
    expect(sent).not.toContain('set-sparse-source');
  });
});
