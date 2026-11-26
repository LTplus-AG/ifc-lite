/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Out-of-core ingest's telemetry arm is what the pool ran: `onOutOfCoreDecision` hears `false` at the start of a
 * load that does not run out of core, and the scan's outcome (sparse sources or the whole-file index) for one that
 * does. The host's `outOfCore` decision (the viewer's PostHog ramp) reaches the pool without any global or URL param.
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

/** One load whose pre-pass emits an index and (when asked for) the sparse facts, with no jobs. */
async function load(outOfCore: boolean | undefined, unsupported?: string) {
  const created: FakeWorker[] = [];
  vi.stubGlobal('Worker', vi.fn().mockImplementation(function () {
    const worker = new FakeWorker((self, message) => {
      const emit = (event: Record<string, unknown>) => self.reply({ type: 'prepass-stream', event });
      if (message.type === 'scan-shard') {
        // The whole-file path's sharded scan: an empty stitch falls back to the serial pre-pass.
        queueMicrotask(() => self.reply({ type: 'shard-result', shardIndex: message.shardIndex, ids: new Uint32Array(), starts: new Uint32Array(), lengths: new Uint32Array(), classes: new Uint8Array(), handoff: -1 }));
      } else if (message.type === 'prepass-streaming') {
        queueMicrotask(() => {
          emit({ type: 'entity-index', ids: Uint32Array.from([1]), starts: Uint32Array.from([0]), lengths: Uint32Array.from([4]) });
          if (message.emitSparseFacts) {
            emit({ type: 'sparse-facts', preamble: Uint8Array.from([1]), inverseTargets: new Uint32Array(), inverseReferrers: new Uint32Array(), ...(unsupported ? { unsupported } : {}) });
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
  const shared = new SharedArrayBuffer(27 * 1024 * 1024);
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
  return { decisions, failure, sent: created.flatMap((w) => w.received.map((m) => m.type)) };
}

describe('out-of-core decision of one pool load', () => {
  it('reports the whole-file path at the start when the flag is unset or off', async () => {
    for (const flag of [undefined, false]) {
      const { decisions, failure, sent } = await load(flag);
      expect(failure).toBeUndefined();
      expect(decisions).toEqual([false]);
      expect(sent).not.toContain('set-sparse-source');
    }
  });

  it("runs out of core on the host's decision alone and reports it once the workers have their sparse sources", async () => {
    const { decisions, failure, sent } = await load(true);
    expect(failure).toBeUndefined();
    expect(sent).toContain('set-sparse-source');
    expect(decisions).toEqual([true]);
  });

  it('reports the whole-file path when the scan finds a file the arena cannot serve', async () => {
    const { decisions, failure, sent } = await load(true, 'annotation fill areas');
    expect(failure).toBeUndefined();
    expect(sent).not.toContain('set-sparse-source');
    expect(sent).toContain('set-entity-index');
    expect(decisions).toEqual([false]);
  });
});
