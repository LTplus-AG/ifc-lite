/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #4902: a pre-worker pipeline phase that waits on a single worker's
 * reply (a sharded `scan-shard`, a `resolve-styles-shard` slice, or the
 * `finalize-styles` unicast to worker[0]) could wait forever — nothing but
 * the phase-blind 30-150s stream watchdog would ever catch it. These drive
 * `processParallel`'s real message protocol with fake workers that go silent
 * on exactly one of those replies, and assert: a typed diagnostics entry
 * lands within the bound, the load still completes via the documented
 * fallback, and `stallPhaseHandle.getStallPhase()` reports the phase that
 * was actually stuck while it is stuck.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processParallel } from './geometry-parallel.js';
import { CoordinateHandler } from './coordinate-handler.js';
import type { StallPhaseHandle } from './stall-phase.js';
import type { StreamingGeometryEvent } from './index.js';

const SOURCE = '#1=IFCWALL();#2=IFCBEAM();';

function jobFor(id: number): number[] {
  const start = SOURCE.indexOf(`#${id}=`);
  return [id, start, SOURCE.indexOf(';', start) + 1];
}

interface Posted { type?: string; [k: string]: unknown }

class FakeWorker {
  readonly received: Posted[] = [];
  terminate = vi.fn();
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(private readonly onPost: (self: FakeWorker, msg: Posted) => void) {}
  postMessage(msg: Posted): void {
    this.received.push(msg);
    this.onPost(this, msg);
  }
  reply(data: unknown): void {
    this.onmessage?.({ data });
  }
}

let created: FakeWorker[];
let originalWorker: unknown;

beforeEach(() => {
  created = [];
  originalWorker = (globalThis as Record<string, unknown>).Worker;
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  (globalThis as Record<string, unknown>).Worker = originalWorker;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A process worker's reply to one `stream-chunk`: one batch, then `slice-done`. */
function replyToChunk(self: FakeWorker, msg: Posted): void {
  const flat = msg.jobsFlat as Uint32Array;
  const ids: number[] = [];
  for (let i = 0; i < flat.length; i += 3) ids.push(flat[i]);
  self.reply({
    type: 'batch',
    meshes: ids.map((expressId) => ({
      expressId,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1],
    })),
  });
  self.reply({ type: 'slice-done', seq: msg.seq });
}

/** Process-worker behaviour shared by every fixture below: reply to
 *  `stream-chunk` and `stream-end`, ignore every other setup message. */
function installedProcessBehaviour(self: FakeWorker, msg: Posted): void {
  if (msg.type === 'stream-chunk') replyToChunk(self, msg);
  else if (msg.type === 'stream-end') self.reply({ type: 'complete', totalMeshes: 0 });
}

async function drainOrTimeout(gen: AsyncGenerator<StreamingGeometryEvent>, advanceMs: number) {
  const events: StreamingGeometryEvent[] = [];
  const drain = (async () => {
    for await (const event of gen) events.push(event);
  })();
  await vi.advanceTimersByTimeAsync(advanceMs);
  await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 0))]);
  return events;
}

describe('processParallel pre-worker phase bounds (#4902)', () => {
  it('bounds a silent scan-shard, falls back to the serial pre-pass, and reports the phase while stuck', async () => {
    const stallPhaseHandle: StallPhaseHandle = {};
    (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function (this: unknown) {
      const worker = new FakeWorker((self, msg) => {
        if (msg.type === 'scan-shard') return; // both shards hang forever
        if (msg.type === 'prepass-streaming') {
          // Serial fallback: the #4902 timeout's `startPrepass(false)`.
          queueMicrotask(() => {
            const emit = (event: Record<string, unknown>) => self.reply({ type: 'prepass-stream', event });
            emit({ type: 'meta', unitScale: 1, rtcOffset: new Float64Array([0, 0, 0]), needsShift: false });
            emit({
              type: 'entity-index',
              ids: new Uint32Array([1, 2]), starts: new Uint32Array([0, 13]), lengths: new Uint32Array([13, 13]),
            });
            emit({
              type: 'styles',
              styleIds: new Uint32Array(0), styleColors: new Uint8Array(0),
              voidKeys: new Uint32Array(0), voidCounts: new Uint32Array(0), voidValues: new Uint32Array(0),
            });
            emit({ type: 'jobs', jobs: new Uint32Array([...jobFor(1), ...jobFor(2)]) });
            emit({ type: 'complete', totalJobs: 2 });
          });
          return;
        }
        installedProcessBehaviour(self, msg);
      });
      created.push(worker);
      return worker;
    }) as unknown as typeof Worker;

    const shared = new SharedArrayBuffer(8 * 1024 * 1024);
    const gen = processParallel(new Uint8Array(shared), new CoordinateHandler(), undefined, shared, {
      workerCountOverride: 2,
      stallPhaseHandle,
    });

    const events: StreamingGeometryEvent[] = [];
    const drain = (async () => {
      for await (const event of gen) events.push(event);
    })();
    // Let the pool's synchronous setup (through the shard-scan dispatch) run
    // before either bound has had a chance to fire.
    await vi.advanceTimersByTimeAsync(0);
    expect(stallPhaseHandle.getStallPhase?.()).toBe('shard-scan');

    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 0))]);
    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.type === 'complete' && complete.diagnostics?.failuresByReason).toContainEqual({
      reason: 'shard-scan-timeout', count: 1,
    });
    const rendered = events.flatMap((e) => (e.type === 'batch' ? e.meshes.map((m) => m.expressId) : []));
    expect(rendered.sort()).toEqual([1, 2]);
  });

  it('bounds a silent style slice, proceeds with the slices that answered, and still finalizes', async () => {
    const HANG_SLICE = 1;
    (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function (this: unknown) {
      const worker = new FakeWorker((self, msg) => {
        if (msg.type === 'scan-shard') {
          const shardIndex = msg.shardIndex as number;
          queueMicrotask(() => self.reply({
            type: 'shard-result', shardIndex,
            ids: new Uint32Array([shardIndex + 1]), starts: new Uint32Array([shardIndex === 0 ? 0 : 13]),
            lengths: new Uint32Array([13]), classes: new Uint8Array([0]), handoff: shardIndex === 0 ? 13 : -1,
          }));
          return;
        }
        if (msg.type === 'resolve-styles-shard') {
          if (msg.sliceIndex === HANG_SLICE) return; // this one slice hangs
          queueMicrotask(() => self.reply({
            type: 'styles-shard-result', sliceIndex: msg.sliceIndex,
            orphanIds: new Uint32Array(0), orphanColors: new Float32Array(0),
            geomIds: new Uint32Array(0), geomColors: new Float32Array(0),
          }));
          return;
        }
        if (msg.type === 'finalize-styles') {
          queueMicrotask(() => self.reply({
            type: 'styles-final',
            payload: {
              styleIds: new Uint32Array(0), styleColors: new Uint8Array(0),
              voidKeys: new Uint32Array(0), voidCounts: new Uint32Array(0), voidValues: new Uint32Array(0),
            },
          }));
          return;
        }
        if (msg.type === 'prepass-streaming-sharded') {
          queueMicrotask(() => {
            const emit = (event: Record<string, unknown>) => self.reply({ type: 'prepass-stream', event });
            emit({ type: 'meta', unitScale: 1, rtcOffset: new Float64Array([0, 0, 0]), needsShift: false });
            emit({ type: 'jobs', jobs: new Uint32Array([...jobFor(1), ...jobFor(2)]) });
            emit({ type: 'complete', totalJobs: 2 });
          });
          return;
        }
        installedProcessBehaviour(self, msg);
      });
      created.push(worker);
      return worker;
    }) as unknown as typeof Worker;

    const shared = new SharedArrayBuffer(8 * 1024 * 1024);
    const gen = processParallel(new Uint8Array(shared), new CoordinateHandler(), undefined, shared, {
      workerCountOverride: 2,
    });

    const events = await drainOrTimeout(gen, 20_000);
    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.type === 'complete' && complete.diagnostics?.failuresByReason).toContainEqual({
      reason: 'style-slice-timeout', count: 1,
    });
    const rendered = events.flatMap((e) => (e.type === 'batch' ? e.meshes.map((m) => m.expressId) : []));
    expect(rendered.sort()).toEqual([1, 2]);
  });

  it('bounds a silent finalize-styles reply and drains with default colours', async () => {
    (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function (this: unknown) {
      const index = created.length;
      const worker = new FakeWorker((self, msg) => {
        if (msg.type === 'scan-shard') {
          const shardIndex = msg.shardIndex as number;
          queueMicrotask(() => self.reply({
            type: 'shard-result', shardIndex,
            ids: new Uint32Array([shardIndex + 1]), starts: new Uint32Array([shardIndex === 0 ? 0 : 13]),
            lengths: new Uint32Array([13]), classes: new Uint8Array([0]), handoff: shardIndex === 0 ? 13 : -1,
          }));
          return;
        }
        if (msg.type === 'resolve-styles-shard') {
          queueMicrotask(() => self.reply({
            type: 'styles-shard-result', sliceIndex: msg.sliceIndex,
            orphanIds: new Uint32Array(0), orphanColors: new Float32Array(0),
            geomIds: new Uint32Array(0), geomColors: new Float32Array(0),
          }));
          return;
        }
        // Worker 0 owns finalize-styles and never replies.
        if (msg.type === 'finalize-styles') return;
        if (index === 0 && msg.type === 'prepass-streaming-sharded') return; // n/a: worker0 is a process worker
        if (msg.type === 'prepass-streaming-sharded') {
          queueMicrotask(() => {
            const emit = (event: Record<string, unknown>) => self.reply({ type: 'prepass-stream', event });
            emit({ type: 'meta', unitScale: 1, rtcOffset: new Float64Array([0, 0, 0]), needsShift: false });
            emit({ type: 'jobs', jobs: new Uint32Array([...jobFor(1), ...jobFor(2)]) });
            emit({ type: 'complete', totalJobs: 2 });
          });
          return;
        }
        installedProcessBehaviour(self, msg);
      });
      created.push(worker);
      return worker;
    }) as unknown as typeof Worker;

    const shared = new SharedArrayBuffer(8 * 1024 * 1024);
    const gen = processParallel(new Uint8Array(shared), new CoordinateHandler(), undefined, shared, {
      workerCountOverride: 2,
    });

    const events = await drainOrTimeout(gen, 20_000);
    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.type === 'complete' && complete.diagnostics?.failuresByReason).toContainEqual({
      reason: 'styles-finalize-timeout', count: 1,
    });
    // Set-styles reached the workers with default (empty) colours — the gate
    // opened via the fallback, not via a real finalize reply.
    const setStyles = created[0].received.filter((m) => m.type === 'set-styles');
    expect(setStyles).toHaveLength(1);
    expect((setStyles[0].styleIds as Uint32Array).length).toBe(0);
    const rendered = events.flatMap((e) => (e.type === 'batch' ? e.meshes.map((m) => m.expressId) : []));
    expect(rendered.sort()).toEqual([1, 2]);
  });

  it('happy path: no bound trips, so no #4902 diagnostics are emitted', async () => {
    (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function (this: unknown) {
      const worker = new FakeWorker((self, msg) => {
        if (msg.type === 'scan-shard') {
          const shardIndex = msg.shardIndex as number;
          queueMicrotask(() => self.reply({
            type: 'shard-result', shardIndex,
            ids: new Uint32Array([shardIndex + 1]), starts: new Uint32Array([shardIndex === 0 ? 0 : 13]),
            lengths: new Uint32Array([13]), classes: new Uint8Array([0]), handoff: shardIndex === 0 ? 13 : -1,
          }));
          return;
        }
        if (msg.type === 'resolve-styles-shard') {
          queueMicrotask(() => self.reply({
            type: 'styles-shard-result', sliceIndex: msg.sliceIndex,
            orphanIds: new Uint32Array(0), orphanColors: new Float32Array(0),
            geomIds: new Uint32Array(0), geomColors: new Float32Array(0),
          }));
          return;
        }
        if (msg.type === 'finalize-styles') {
          queueMicrotask(() => self.reply({
            type: 'styles-final',
            payload: {
              styleIds: new Uint32Array(0), styleColors: new Uint8Array(0),
              voidKeys: new Uint32Array(0), voidCounts: new Uint32Array(0), voidValues: new Uint32Array(0),
            },
          }));
          return;
        }
        if (msg.type === 'prepass-streaming-sharded') {
          queueMicrotask(() => {
            const emit = (event: Record<string, unknown>) => self.reply({ type: 'prepass-stream', event });
            emit({ type: 'meta', unitScale: 1, rtcOffset: new Float64Array([0, 0, 0]), needsShift: false });
            emit({ type: 'jobs', jobs: new Uint32Array([...jobFor(1), ...jobFor(2)]) });
            emit({ type: 'complete', totalJobs: 2 });
          });
          return;
        }
        installedProcessBehaviour(self, msg);
      });
      created.push(worker);
      return worker;
    }) as unknown as typeof Worker;

    const stallPhaseHandle: StallPhaseHandle = {};
    const shared = new SharedArrayBuffer(8 * 1024 * 1024);
    const gen = processParallel(new Uint8Array(shared), new CoordinateHandler(), undefined, shared, {
      workerCountOverride: 2,
      stallPhaseHandle,
    });

    // Nothing hangs, so draining doesn't need to advance any bound.
    const events = await drainOrTimeout(gen, 0);
    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.type === 'complete' && complete.diagnostics).toBeUndefined();
    expect(stallPhaseHandle.getStallPhase?.()).toBe('workers');
  });
});
