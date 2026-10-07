/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Prewarmed workers (#7036): a host spawns a load's workers when the load is
 * requested (beside the file read) and `processParallel` leases them instead
 * of spawning. These tests drive the real pipeline against a fake worker that
 * speaks the pre-pass and stream protocols, and pin the contract:
 *   - a load whose workers were prewarmed spawns none (the creation guard);
 *   - a prewarmed worker gets this load's own init and toggles;
 *   - every leased worker is terminated by its load, on success, failure and
 *     abort alike: none is ever handed to a second load;
 *   - idle prewarmed workers are bounded (count and booked bytes), dropped by
 *     a large load that did not lease them, and terminated after a long idle.
 *
 * The pool is reached through `geometry-parallel.js` (an existing module), so
 * a revert that removes it fails these tests on an assertion, not on import.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as parallel from './geometry-parallel.js';
import { CoordinateHandler } from './coordinate-handler.js';
import type { StreamingGeometryEvent } from './index.js';

type Msg = { type?: string; [k: string]: unknown };
type PoolCtor = new (options?: Record<string, unknown>) => {
  acquire(role: string, key: string): { worker: unknown; prewarmed: boolean };
  prewarm(count: number, key: string, init: (w: unknown) => void): number;
  drain(reason?: string): number;
  stats(): { idle: number; idleBytes: number; spawned: number; prewarmed: number; leasedWarm: number };
};

const MB = 1024 * 1024;

interface FakeOptions {
  /** Post an `error` instead of a batch for every stream-chunk. */
  failChunks?: boolean;
  /** Never answer stream-chunk (a load that has to be aborted). */
  hangChunks?: boolean;
}

/** A role-agnostic stand-in for `geometry.worker.ts` (pooled workers change role). */
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  received: Msg[] = [];
  terminate = vi.fn(() => { this.terminated = true; });
  constructor(private readonly opts: FakeOptions) { FakeWorker.all.push(this); }

  private post(data: Msg): void {
    queueMicrotask(() => {
      if (!this.terminated) this.onmessage?.({ data });
    });
  }

  /** A hung call blocks the worker's FIFO: nothing after it runs. */
  private blocked = false;

  postMessage(msg: Msg): void {
    this.received.push(msg);
    if (this.terminated || this.blocked) return;
    switch (msg.type) {
      case 'prepass-streaming': {
        const ev = (event: Msg) => this.post({ type: 'prepass-stream', event });
        ev({ type: 'meta', unitScale: 1, rtcOffset: new Float64Array([0, 0, 0]), needsShift: false });
        ev({ type: 'styles', styleIds: new Uint32Array(0), styleColors: new Uint8Array(0), voidKeys: new Uint32Array(0),
          voidCounts: new Uint32Array(0), voidValues: new Uint32Array(0) });
        ev({ type: 'entity-index', ids: new Uint32Array([1]), starts: new Uint32Array([0]), lengths: new Uint32Array([4]) });
        ev({ type: 'jobs', jobs: new Uint32Array([1, 0, 4, 2, 4, 4]) });
        ev({ type: 'complete', totalJobs: 2 });
        return;
      }
      case 'stream-chunk': {
        if (this.opts.hangChunks) { this.blocked = true; return; }
        if (this.opts.failChunks) { this.post({ type: 'error', message: 'chunk failed' }); return; }
        const jobs = msg.jobsFlat as Uint32Array;
        const meshes = [];
        for (let i = 0; i < jobs.length; i += 3) {
          meshes.push({ expressId: jobs[i], positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] });
        }
        this.post({ type: 'batch', meshes });
        return;
      }
      case 'stream-end':
        this.post({ type: 'memory', wasmHeapBytes: 20 * MB, meshBytes: 0 });
        this.post({ type: 'complete', totalMeshes: 0 });
        return;
      default:
    }
  }
}

let originalWorker: unknown;
let fakeOptions: FakeOptions;
const spawned = () => FakeWorker.all.length;

beforeEach(() => {
  FakeWorker.all = [];
  fakeOptions = {};
  originalWorker = (globalThis as Record<string, unknown>).Worker;
  (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function () {
    return new FakeWorker(fakeOptions);
  });
});

afterEach(() => {
  (globalThis as Record<string, unknown>).Worker = originalWorker;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function poolCtor(): PoolCtor {
  const ctor = (parallel as Record<string, unknown>).GeometryWorkerPool;
  expect(typeof ctor).toBe('function');
  return ctor as PoolCtor;
}

async function drain(gen: AsyncGenerator<StreamingGeometryEvent>, ms = 1_000): Promise<StreamingGeometryEvent[]> {
  const events: StreamingGeometryEvent[] = [];
  const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMED_OUT')), ms));
  const run = (async () => { for await (const e of gen) events.push(e); return events; })();
  return Promise.race([run, deadline]);
}

/** Let release handshakes (microtasks) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function load(pool: unknown, extra: Record<string, unknown> = {}) {
  return parallel.processParallel(new Uint8Array(64 * 1024), new CoordinateHandler(), undefined, undefined,
    { workerCountOverride: 2, workerPool: pool, ...extra } as parallel.ProcessParallelOptions);
}

const meshTotal = (events: StreamingGeometryEvent[]) => {
  const done = events.find((e) => e.type === 'complete');
  return done?.type === 'complete' ? done.totalMeshes : -1;
};

const init = (w: unknown) => (w as FakeWorker).postMessage({ type: 'init' });

describe('processParallel with prewarmed workers (#7036)', () => {
  it('spawns no worker for a load whose workers were prewarmed', async () => {
    const pool = new (poolCtor())();
    expect(pool.prewarm(3, '', init)).toBe(3); // 2 geometry + 1 pre-pass
    expect(spawned()).toBe(3);
    const events = await drain(load(pool));
    expect(spawned()).toBe(3); // the creation guard: zero spawns on this load's path
    expect(pool.stats().leasedWarm).toBe(3);
    expect(pool.stats().idle).toBe(0);
    expect(meshTotal(events)).toBe(2);
  });

  it('leases what is prewarmed and spawns the rest', async () => {
    const pool = new (poolCtor())();
    pool.prewarm(1, '', init);
    await drain(load(pool));
    expect(spawned()).toBe(3);
    expect(pool.stats().leasedWarm).toBe(1);
  });

  it('sends a prewarmed worker this load\'s own init and toggles (federated: instancing off)', async () => {
    const pool = new (poolCtor())();
    pool.prewarm(3, '', (w) => (w as FakeWorker).postMessage({ type: 'init', prewarm: true }));
    await drain(load(pool, { enableInstancing: false }));
    const geometryWorkers = FakeWorker.all.filter((w) => w.received.some((m) => m.type === 'stream-start'));
    expect(geometryWorkers).toHaveLength(2);
    for (const w of geometryWorkers) {
      const types = w.received.map((m) => m.type);
      const loadInit = w.received.findIndex((m) => m.type === 'init' && !m.prewarm);
      expect(loadInit).toBeGreaterThan(0);
      expect(loadInit).toBeLessThan(types.indexOf('stream-start'));
      expect(w.received.find((m) => m.type === 'set-instancing-enabled')?.enabled).toBe(false);
    }
  });

  it('terminates every leased worker when its load ends, so no worker serves two loads', async () => {
    const pool = new (poolCtor())();
    pool.prewarm(3, '', init);
    await drain(load(pool));
    await settle();
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
    await drain(load(pool));
    expect(spawned()).toBe(6); // the second load gets fresh workers, never the first load's
    const streamStarts = FakeWorker.all.map((w) => w.received.filter((m) => m.type === 'stream-start').length);
    expect(Math.max(...streamStarts)).toBe(1);
  });

  it('terminates the leased workers of a failed load', async () => {
    const pool = new (poolCtor())();
    pool.prewarm(3, '', init);
    fakeOptions.failChunks = true;
    for (const w of FakeWorker.all) (w as unknown as { opts: FakeOptions }).opts.failChunks = true;
    await expect(drain(load(pool))).rejects.toThrow(/chunk failed/);
    await settle();
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
    expect(pool.stats().idle).toBe(0);
  });

  it('terminates the leased workers of an aborted load', async () => {
    const pool = new (poolCtor())();
    pool.prewarm(3, '', init);
    for (const w of FakeWorker.all) (w as unknown as { opts: FakeOptions }).opts.hangChunks = true;
    const controller = new AbortController();
    const gen = load(pool, { signal: controller.signal });
    const reader = (async () => { for await (const _ of gen) { /* drain */ } })();
    for (let i = 0; i < 50 && !FakeWorker.all.some((w) => w.received.some((m) => m.type === 'stream-chunk')); i++) await settle();
    controller.abort();
    await reader;
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
  });

  it('bounds the idle pool by count and by booked bytes', async () => {
    const MB16 = parallel.FRESH_WORKER_HEAP_BYTES;
    expect(MB16).toBeGreaterThan(0);
    const byCount = new (poolCtor())({ limits: { maxIdle: 2 } });
    expect(byCount.prewarm(5, '', init)).toBe(2);
    const byBytes = new (poolCtor())({ limits: { idleBytesCeiling: 3 * MB16 } });
    expect(byBytes.prewarm(5, '', init)).toBe(3);
    expect(byBytes.stats().idleBytes).toBeLessThanOrEqual(3 * MB16);
    // The defaults: the 8-worker cap plus a pre-pass worker, never more booked bytes than that.
    const defaults = new (poolCtor())();
    expect(defaults.prewarm(20, '', init)).toBe(9);
    expect(defaults.stats().idleBytes).toBeLessThanOrEqual(9 * MB16);
  });

  it('terminates the prewarmed workers a large load did not lease, so they do not add to its peak', async () => {
    const pool = new (poolCtor())();
    pool.prewarm(4, '', init);
    const big = parallel.processParallel(new Uint8Array(65 * 1024 * 1024), new CoordinateHandler(), undefined, undefined,
      { workerCountOverride: 1, workerPool: pool } as unknown as parallel.ProcessParallelOptions);
    await drain(big, 5_000);
    expect(spawned()).toBe(4);
    expect(pool.stats().idle).toBe(0);
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
  });

  it('#7048 repeated prewarm requests cannot extend unused workers beyond their expiry', () => {
    vi.useFakeTimers();
    const pool = new (poolCtor())({ limits: { idleReleaseMs: 60_000 } });
    expect(pool.prewarm(2, 'engine', () => {})).toBe(2);
    vi.advanceTimersByTime(50_000);
    expect(pool.prewarm(2, 'engine', () => {})).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(pool.stats().idle).toBe(0);
    expect(FakeWorker.all.every(worker => worker.terminated)).toBe(true);
  });

  it('terminates idle prewarmed workers after a long idle, and those for another engine binary', () => {
    vi.useFakeTimers();
    const pool = new (poolCtor())({ limits: { idleReleaseMs: 60_000 } });
    pool.prewarm(2, '', init);
    vi.advanceTimersByTime(59_000);
    expect(pool.stats().idle).toBe(2);
    vi.advanceTimersByTime(2_000);
    expect(pool.stats().idle).toBe(0);
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
    pool.prewarm(1, 'a.wasm', init);
    pool.acquire('geometry', 'b.wasm');
    expect(FakeWorker.all[2].terminated).toBe(true);
  });

  it('keeps spawn-per-load exactly when no pool is passed', async () => {
    await drain(load(undefined));
    await drain(load(undefined));
    expect(spawned()).toBe(6);
    await settle();
    expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
  });
});
