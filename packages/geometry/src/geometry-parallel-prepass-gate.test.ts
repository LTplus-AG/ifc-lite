/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10264, pool side of the pre-pass overlap gate: on a gated load (large
 * source, ONE planned worker) the process worker receives no per-load setup or
 * jobs chunk while the pre-pass is still running; once it completes, its
 * worker is terminated first and then the process worker receives the exact
 * message sequence an ungated load sends. A large load planned with 2+
 * workers is not held and keeps the sharded index scan. Drives
 * `processParallel`'s real message protocol with fake workers (fixture
 * pattern: geometry-parallel-hung-job).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processParallel } from './geometry-parallel.js';
import { CoordinateHandler } from './coordinate-handler.js';
import type { StreamingGeometryEvent } from './index.js';

const gate = vi.hoisted(() => ({ minBytes: Number.POSITIVE_INFINITY }));
// Only the size threshold is scaled down for the test; the worker-count rule is the real one.
vi.mock('./prepass-overlap-gate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./prepass-overlap-gate.js')>();
  return {
    ...real,
    holdsPoolUntilPrepassEnds: (bytes: number, workers: number) =>
      real.holdsPoolUntilPrepassEnds(bytes >= gate.minBytes ? real.PREPASS_OVERLAP_GATE_MIN_BYTES : 0, workers),
  };
});

const SOURCE = '#1=IFCWALL();#2=IFCBEAM();#3=IFCSLAB();';
const SOURCE_BYTES = 8 * 1024 * 1024; // the shard scan's minimum, so only the gate can keep it off

function jobFor(id: number): number[] {
  const start = SOURCE.indexOf(`#${id}=`);
  return [id, start, SOURCE.indexOf(';', start) + 1];
}

interface Posted { type?: string; [k: string]: unknown }

class FakeWorker {
  readonly received: Posted[] = [];
  terminate = vi.fn(() => { timeline.push(`${this.label}:terminate`); });
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  label = '';
  constructor(private readonly onPost: (self: FakeWorker, msg: Posted) => void) {}
  postMessage(msg: Posted): void {
    this.received.push(msg);
    timeline.push(`${this.label}:${msg.type}`);
    this.onPost(this, msg);
  }
  reply(data: unknown): void {
    this.onmessage?.({ data });
  }
}

let created: FakeWorker[];
let timeline: string[];
let originalWorker: unknown;

beforeEach(() => {
  created = [];
  timeline = [];
  originalWorker = (globalThis as Record<string, unknown>).Worker;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  (globalThis as Record<string, unknown>).Worker = originalWorker;
  gate.minBytes = Number.POSITIVE_INFINITY;
  vi.restoreAllMocks();
});

/** Process workers are created first (`workerCount` of them), the pre-pass
 *  worker last. The pre-pass emits everything but `complete`, which the test
 *  sends itself so it can look at the pool in between. */
function installFakeWorkers(workerCount: number): void {
  (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function (this: unknown) {
    const index = created.length;
    const isPrepass = index === workerCount;
    const worker = new FakeWorker((self, msg) => {
      if (isPrepass) {
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
        });
        return;
      }
      if (msg.type === 'stream-chunk') {
        queueMicrotask(() => {
          self.reply({ type: 'batch', meshes: [] });
          self.reply({ type: 'slice-done', seq: msg.seq });
        });
      } else if (msg.type === 'stream-end') {
        queueMicrotask(() => self.reply({ type: 'complete', totalMeshes: 0 }));
      }
    });
    worker.label = isPrepass ? 'prepass' : `geom${index}`;
    created.push(worker);
    return worker;
  }) as unknown as typeof Worker;
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Runs a load up to (but not including) the pre-pass `complete`, snapshots
 *  the timeline, then completes the pre-pass and drains the generator. */
async function runLoad(workerCount: number): Promise<{ beforeComplete: string[]; events: StreamingGeometryEvent[] }> {
  installFakeWorkers(workerCount);
  const shared = new SharedArrayBuffer(SOURCE_BYTES);
  new Uint8Array(shared).set(new TextEncoder().encode(SOURCE));
  const gen = processParallel(new Uint8Array(shared), new CoordinateHandler(), undefined, shared, {
    workerCountOverride: workerCount,
  });
  const events: StreamingGeometryEvent[] = [];
  const drain = (async () => {
    for await (const event of gen) events.push(event);
  })();
  for (let i = 0; i < 5; i++) await settle();
  const beforeComplete = [...timeline];
  const prepass = created[workerCount];
  prepass.reply({ type: 'prepass-stream', event: { type: 'complete', totalJobs: 3 } });
  await Promise.race([
    drain,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMED_OUT: load never completed')), 1_000)),
  ]);
  return { beforeComplete, events };
}

const CONFIG = ['init', 'set-merge-layers', 'set-instancing-enabled', 'set-compute-geometry-hashes', 'set-tessellation-quality', 'set-skip-small-cuts'];
const LOAD = ['stream-start', 'set-entity-index', 'set-styles', 'stream-chunk', 'stream-end'];
const types = (w: FakeWorker) => w.received.map((m) => m.type);

describe('processParallel pre-pass overlap gate (#10264)', () => {
  it('ungated: the pool starts this load while the pre-pass is still running (unchanged behaviour)', async () => {
    const { beforeComplete, events } = await runLoad(1);
    expect(beforeComplete).toContain('geom0:stream-start');
    expect(beforeComplete).toContain('geom0:set-entity-index');
    expect(beforeComplete).toContain('geom0:stream-chunk');
    expect(types(created[0])).toEqual([...CONFIG, ...LOAD]);
    expect(events.at(-1)?.type).toBe('complete');
  });

  it('gated: no setup or chunk reaches the pool before the pre-pass ends, then the same sequence after its worker is gone', async () => {
    gate.minBytes = 1024 * 1024;
    const { beforeComplete, events } = await runLoad(1);
    const poolBefore = beforeComplete.filter((t) => t.startsWith('geom0:')).map((t) => t.slice('geom0:'.length));
    expect(poolBefore).toEqual(CONFIG);

    expect(types(created[0])).toEqual([...CONFIG, ...LOAD]);
    const after = timeline.slice(beforeComplete.length);
    expect(after[0]).toBe('prepass:terminate');
    expect(after.indexOf('prepass:terminate')).toBeLessThan(after.indexOf('geom0:stream-start'));
    expect(events.at(-1)?.type).toBe('complete');
  });

  it.each([2, 3])('large source planned with %i workers: not held, sharded index scan on (main path)', async (workerCount) => {
    const controller = new AbortController();
    const load = await startHeldLoad(workerCount, controller.signal);
    for (let i = 0; i < workerCount; i++) expect(types(created[i])).toContain('scan-shard');
    expect(types(created[workerCount])).not.toContain('prepass-streaming'); // waits for the stitched index, as on main
    controller.abort();
    await load.settled();
  });
});

/** Starts a large load (above the scaled gate threshold) and pumps it; with
 *  one worker the pool is then holding (pre-pass has sent meta, entity-index,
 *  styles and jobs, but not `complete`). */
async function startHeldLoad(workerCount: number, signal?: AbortSignal) {
  gate.minBytes = 1024 * 1024;
  installFakeWorkers(workerCount);
  const shared = new SharedArrayBuffer(SOURCE_BYTES);
  new Uint8Array(shared).set(new TextEncoder().encode(SOURCE));
  const gen = processParallel(new Uint8Array(shared), new CoordinateHandler(), undefined, shared, {
    workerCountOverride: workerCount, signal,
  });
  const events: StreamingGeometryEvent[] = [];
  let error: unknown = null;
  const drain = (async () => {
    try {
      for await (const event of gen) events.push(event);
    } catch (err) {
      error = err;
    }
  })();
  for (let i = 0; i < 5; i++) await settle();
  const settled = () => Promise.race([
    drain,
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMED_OUT: load never settled')), 1_000)),
  ]);
  return { events, error: () => error, settled, prepass: created[workerCount] };
}

/** No held message reached any process worker, and every worker was terminated. */
function expectNothingReleasedAndAllTerminated(workerCount: number): void {
  for (let i = 0; i < workerCount; i++) {
    expect(types(created[i])).toEqual(CONFIG);
    expect(created[i].terminate).toHaveBeenCalled();
  }
  expect(created[workerCount].terminate).toHaveBeenCalled();
}

describe('processParallel pre-pass overlap gate: ending a load during the hold (#10264)', () => {
  it('abort during the hold', async () => {
    const controller = new AbortController();
    const load = await startHeldLoad(1, controller.signal);
    expect(types(created[0])).toEqual(CONFIG); // holding
    controller.abort();
    await load.settled();
    expect(load.events.some((e) => e.type === 'complete')).toBe(false);
    expectNothingReleasedAndAllTerminated(1);
  });

  it('pre-pass reports an error during the hold', async () => {
    const load = await startHeldLoad(1);
    load.prepass.reply({ type: 'error', message: 'boom' });
    await load.settled();
    expect(String(load.error())).toMatch(/Pre-pass worker error: boom/);
    expectNothingReleasedAndAllTerminated(1);
  });

  it('pre-pass worker crashes during the hold', async () => {
    const load = await startHeldLoad(1);
    load.prepass.onerror?.({ message: 'worker crashed', filename: 'geometry.worker.js', lineno: 1 });
    await load.settled();
    expect(String(load.error())).toMatch(/Pre-pass worker failed/);
    expectNothingReleasedAndAllTerminated(1);
  });

  it('consumer stops at the rtcOffset event, which arrives during the hold', async () => {
    gate.minBytes = 1024 * 1024;
    installFakeWorkers(1);
    const shared = new SharedArrayBuffer(SOURCE_BYTES);
    new Uint8Array(shared).set(new TextEncoder().encode(SOURCE));
    const gen = processParallel(new Uint8Array(shared), new CoordinateHandler(), undefined, shared, { workerCountOverride: 1 });
    let sawRtc = false;
    const consume = (async () => {
      for await (const event of gen) {
        if (event.type === 'rtcOffset') { sawRtc = true; break; }
      }
    })();
    await Promise.race([consume, new Promise((_, reject) => setTimeout(() => reject(new Error('TIMED_OUT')), 1_000))]);
    expect(sawRtc).toBe(true);
    expectNothingReleasedAndAllTerminated(1);
  });
});
