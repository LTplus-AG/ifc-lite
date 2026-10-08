/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Issue #6956: `processParallel` records its phases on the caller's load trace
 * (`options.trace`), asks every worker to record spans, and re-parents the
 * spans they post back under `geometry.pool`. The trace here is a hand-written
 * recorder (not `@ifc-lite/load-trace`), so the test observes the pool's own
 * instrumentation and nothing else.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processParallel } from './geometry-parallel.js';
import { CoordinateHandler } from './coordinate-handler.js';
import type { LoadTrace } from '@ifc-lite/load-trace';
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

interface Call { fn: string; args: unknown[] }

function recordingTrace(): { trace: LoadTrace; calls: Call[] } {
  const calls: Call[] = [];
  let token = 0;
  const note = (fn: string) => (...args: unknown[]) => { calls.push({ fn, args }); };
  const trace = {
    enabled: true,
    setAttrs: note('setAttrs'),
    begin: (...args: unknown[]) => { calls.push({ fn: 'begin', args }); return token++; },
    end: note('end'),
    milestone: (...args: unknown[]) => { calls.push({ fn: 'milestone', args }); return 0; },
    merge: note('merge'),
    record: note('record'),
    span: (name: string, run: () => unknown, ...rest: unknown[]) => { calls.push({ fn: 'span', args: [name, ...rest] }); return run(); },
  } as unknown as LoadTrace;
  return { trace, calls };
}

describe('processParallel load-trace spans (#6956)', () => {
  it('records the pool phases, enables worker tracing and parents worker spans under geometry.pool', async () => {
    (globalThis as Record<string, unknown>).Worker = vi.fn().mockImplementation(function (this: unknown) {
      const worker = new FakeWorker((self, msg) => {
        if (msg.type === 'scan-shard') return; // force the serial pre-pass fallback
        if (msg.type === 'prepass-streaming') {
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
        if (msg.type === 'stream-chunk') {
          self.reply({
            type: 'load-trace:spans',
            payload: { thread: 'geom-0', timeOrigin: 0, spans: [{ name: 'geometry.firstChunk', start: 1, end: 2 }] },
          });
        }
        installedProcessBehaviour(self, msg);
      });
      created.push(worker);
      return worker;
    }) as unknown as typeof Worker;

    const { trace, calls } = recordingTrace();
    const shared = new SharedArrayBuffer(8 * 1024 * 1024);
    const gen = processParallel(new Uint8Array(shared), new CoordinateHandler(), undefined, shared, {
      workerCountOverride: 2,
      trace,
    });
    const events: StreamingGeometryEvent[] = [];
    const drain = (async () => {
      for await (const event of gen) events.push(event);
    })();
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 0))]);
    expect(events.some((e) => e.type === 'complete')).toBe(true);

    const begins = calls.filter((c) => c.fn === 'begin').map((c) => c.args[0]);
    expect(begins).toContain('geometry.pool');
    expect(begins).toContain('geometry.shardScan');
    const milestones = calls.filter((c) => c.fn === 'milestone').map((c) => c.args[0]);
    expect(milestones).toContain('geometry.firstBatch');
    expect(milestones).toContain('prepass.complete');
    expect(calls.find((c) => c.fn === 'setAttrs')?.args[0]).toEqual({ workerCount: 2 });

    // Every worker was asked to record spans.
    expect(created.length).toBeGreaterThanOrEqual(3);
    for (const worker of created.slice(0, 3)) {
      expect(worker.received.some((m) => m.type === 'load-trace:enable')).toBe(true);
    }
    // Worker spans land under the pool span (the first `begin`, token 0).
    const merge = calls.find((c) => c.fn === 'merge');
    expect(merge?.args[1]).toBe(0);
    expect((merge?.args[0] as { thread: string }).thread).toBe('geom-0');
  });
});
