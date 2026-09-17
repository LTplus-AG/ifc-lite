/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processParallel } from './geometry-parallel.js';
import { CoordinateHandler } from './coordinate-handler.js';
import type { StreamingGeometryEvent } from './index.js';

/**
 * Issue #4884: production loads failed with "Geometry stream stalled" at the
 * SAME mesh count on every attempt — one element whose geometry call never
 * returns wedges its worker, and nothing on the host could time that call out.
 *
 * The fixture below scripts the real message protocol with one process worker:
 * the pre-pass emits meta / entity-index / styles / one jobs chunk / complete,
 * and every process worker runs its slices exactly like `processSliceStreaming`
 * (pre-call `progress` heartbeat carrying `seq` + `callJobs`, a `batch` after
 * each call, `slice-done` after the slice) except that a call containing
 * {@link HUNG_ID} never returns, after which that worker ignores every message.
 */

const SOURCE = '#1=IFCWALL();#2=IFCBEAM();#3=IFCSLAB();';
const HUNG_ID = 2;

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
});

afterEach(() => {
  (globalThis as Record<string, unknown>).Worker = originalWorker;
  vi.restoreAllMocks();
});

function mesh(expressId: number) {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  };
}

/** A worker-side diagnostics payload recording `failures` CSG failures. */
function csgDiagnostics(failures: number) {
  return {
    schemaVersion: 3, totalCsgFailures: failures, productsWithFailures: failures, hostsWithOpenings: 0,
    classification: { rectangular: 0, diagonal: 0, nonRectangular: 0, total: 0 },
    failuresByReason: [{ reason: 'fixture', count: failures }], silentNoOps: 0,
    rectFast: { fired: 0, openingsCut: 0, deferHostNotBox: 0, deferNotThrough: 0, deferOffFace: 0, deferNearEdge: 0, deferNoOpenings: 0 },
    worstHosts: [],
  };
}

/** Diagnostics a fake worker has accumulated but not yet reported (per worker). */
const unreported = new WeakMap<FakeWorker, ReturnType<typeof csgDiagnostics>>();

/** Run one slice like `processSliceStreaming`; returns false once the worker hangs. */
async function runSlice(self: FakeWorker, msg: Posted): Promise<boolean> {
  const flat = msg.jobsFlat as Uint32Array;
  const seq = msg.seq as number;
  const total = flat.length / 3;
  const perCall = (msg.maxBatchJobs as number | undefined) ?? total;
  for (let offset = 0; offset < total; offset += perCall) {
    const callJobs = Math.min(perCall, total - offset);
    // Like the worker: the pre-call heartbeat carries the flushed calls' diagnostics.
    const diagnostics = unreported.get(self);
    unreported.delete(self);
    self.reply({ type: 'progress', processedJobs: offset, totalJobs: total, seq, callJobs, diagnostics });
    const callIds: number[] = [];
    for (let j = offset; j < offset + callJobs; j++) callIds.push(flat[j * 3]);
    if (callIds.includes(HUNG_ID)) return false;
    await Promise.resolve();
    self.reply({ type: 'batch', meshes: callIds.map(mesh) });
    // Element 1 records one CSG failure (the only diagnostics in the fixture).
    if (callIds.includes(1)) unreported.set(self, csgDiagnostics(1));
  }
  self.reply({ type: 'slice-done', seq });
  return true;
}

function installFakeWorkers(): void {
  (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function (this: unknown) {
    const index = created.length;
    let queue: Promise<boolean> = Promise.resolve(true);
    const worker = new FakeWorker((self, msg) => {
      if (index === 1) {
        if (msg.type !== 'prepass-streaming') return;
        queueMicrotask(() => {
          const emit = (event: Record<string, unknown>) => self.reply({ type: 'prepass-stream', event });
          emit({ type: 'meta', unitScale: 1, rtcOffset: new Float64Array([0, 0, 0]), needsShift: false });
          emit({
            type: 'entity-index',
            ids: new Uint32Array([1, 2, 3]),
            starts: new Uint32Array([0, 13, 26]),
            lengths: new Uint32Array([13, 13, 13]),
          });
          emit({
            type: 'styles',
            styleIds: new Uint32Array(0), styleColors: new Uint8Array(0),
            voidKeys: new Uint32Array(0), voidCounts: new Uint32Array(0), voidValues: new Uint32Array(0),
          });
          emit({ type: 'jobs', jobs: new Uint32Array([...jobFor(1), ...jobFor(2), ...jobFor(3)]) });
          emit({ type: 'complete', totalJobs: 3 });
        });
        return;
      }
      // Process worker: strictly sequential, and silent forever after a hang.
      queue = queue.then(async (alive) => {
        if (!alive) return false;
        if (msg.type === 'stream-chunk') return runSlice(self, msg);
        if (msg.type === 'stream-end') {
          self.reply({ type: 'complete', totalMeshes: 0, diagnostics: unreported.get(self) });
        }
        return true;
      });
    });
    created.push(worker);
    return worker;
  }) as unknown as typeof Worker;
}

async function drainWithDeadline(gen: AsyncGenerator<StreamingGeometryEvent>, ms: number) {
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

describe('processParallel hung geometry call recovery (#4884)', () => {
  it('replaces the hung worker, skips only the element that never finishes, and completes the load', async () => {
    installFakeWorkers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const gen = processParallel(
      new TextEncoder().encode(SOURCE),
      new CoordinateHandler(),
      undefined,
      undefined,
      { workerCountOverride: 1, hungJobTimeoutMs: 40 },
    );

    const events = await drainWithDeadline(gen, 3_000);

    const complete = events.find((e) => e.type === 'complete');
    expect(complete?.type === 'complete' && complete.skippedHungElements).toEqual({
      expressIds: [HUNG_ID],
      byType: [{ ifcType: 'IFCBEAM', count: 1 }],
    });
    const rendered = events.flatMap((e) => (e.type === 'batch' ? e.meshes.map((m) => m.expressId) : []));
    expect(rendered.sort()).toEqual([1, 3]);
    expect(complete?.type === 'complete' && complete.totalMeshes).toBe(2);
    // Element 1 was meshed by the FIRST replacement, which was itself replaced
    // before it could send `complete`: its diagnostics must still arrive.
    expect(complete?.type === 'complete' && complete.diagnostics?.totalCsgFailures).toBe(1);

    // Pool: process worker 0, pre-pass 1, then two replacements — the first
    // re-ran the hung 3-job call one job per call, the second got only job 3.
    const [original, , firstReplacement, secondReplacement] = created;
    expect(created).toHaveLength(4);
    expect(original.terminate).toHaveBeenCalled();
    expect(firstReplacement.terminate).toHaveBeenCalled();
    const chunks = (w: FakeWorker) =>
      w.received.filter((m) => m.type === 'stream-chunk').map((m) => [Array.from(m.jobsFlat as Uint32Array).filter((_, i) => i % 3 === 0), m.maxBatchJobs]);
    expect(chunks(firstReplacement)).toEqual([[[1, 2, 3], 1]]);
    expect(chunks(secondReplacement)).toEqual([[[3], 1]]);

    // A replacement is brought to the original worker's state before any work.
    const setupOrder = secondReplacement.received.map((m) => m.type);
    expect(setupOrder.slice(0, setupOrder.indexOf('stream-chunk'))).toEqual([
      'init',
      'set-merge-layers',
      'set-instancing-enabled',
      'set-compute-geometry-hashes',
      'set-tessellation-quality',
      'set-skip-small-cuts',
      'stream-start',
      'set-entity-index',
      'set-styles',
    ]);
    expect(setupOrder.at(-1)).toBe('stream-end');
  });

  it('does not recover unless the consumer opts in, so no consumer receives a partial model unasked', async () => {
    installFakeWorkers();
    const gen = processParallel(
      new TextEncoder().encode(SOURCE),
      new CoordinateHandler(),
      undefined,
      undefined,
      { workerCountOverride: 1 },
    );
    await expect(drainWithDeadline(gen, 300)).rejects.toThrow(/TIMED_OUT/);
    expect(created).toHaveLength(2);
  });

  it('terminates the whole pool and ends the stream when aborted while parked on a silent worker', async () => {
    installFakeWorkers();
    const controller = new AbortController();
    const gen = processParallel(
      new TextEncoder().encode(SOURCE),
      new CoordinateHandler(),
      undefined,
      undefined,
      { workerCountOverride: 1, signal: controller.signal },
    );
    const drained = drainWithDeadline(gen, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Parked: before #4884 a consumer's return() queued behind this await and
    // the pool (hung worker included) was never terminated.
    expect(created[0].terminate).not.toHaveBeenCalled();
    controller.abort();

    const events = await drained;
    expect(events.some((e) => e.type === 'complete')).toBe(false);
    expect(created[0].terminate).toHaveBeenCalled();
    expect(created[1].terminate).toHaveBeenCalled();
  });
});
