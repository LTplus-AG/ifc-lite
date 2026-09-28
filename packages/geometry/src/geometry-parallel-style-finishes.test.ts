/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5582, host side of the sharded pre-pass: each style slice returns its
 * `geomFinishes` beside `geomColors`; the host must merge them first-wins in
 * slice order with the SAME winner as the colour (so an id's finish never
 * comes from a different styled item than its colour), hand them to worker[0]
 * with `finalize-styles`, and broadcast the finalized `styleFinishes` to every
 * process worker with `set-styles`. Drives `processParallel`'s real message
 * protocol with fake workers (fixture pattern: geometry-parallel-stall-phase).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processParallel } from './geometry-parallel.js';
import { CoordinateHandler } from './coordinate-handler.js';
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

/** Slice 0 claims #10 with no authored finish (an empty claim) and #11 with
 *  one; slice 1 claims #10 again, authored, plus #20. First-wins keeps slice
 *  0's empty claim for #10 — a merge that took the first AUTHORED finish
 *  instead would read slice 1's [1, 0.125]. */
const SLICES = [
  { geomIds: [10, 11], geomFinishes: [NaN, NaN, 0, 0.25] },
  { geomIds: [10, 20], geomFinishes: [1, 0.125, NaN, 0.75] },
];

const FINAL_STYLE_IDS = [10, 11, 20];
const FINAL_STYLE_FINISHES = [NaN, NaN, 0, 0.25, NaN, 0.75];

function installWorkers(): void {
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
        // Slices past the two above answer empty (the pool may cut more).
        const slice = SLICES[msg.sliceIndex as number] ?? { geomIds: [], geomFinishes: [] };
        queueMicrotask(() => self.reply({
          type: 'styles-shard-result', sliceIndex: msg.sliceIndex,
          orphanIds: new Uint32Array(0), orphanColors: new Float32Array(0),
          geomIds: new Uint32Array(slice.geomIds),
          geomColors: new Float32Array(slice.geomIds.length * 4).fill(0.5),
          geomFinishes: new Float32Array(slice.geomFinishes),
        }));
        return;
      }
      if (msg.type === 'finalize-styles') {
        queueMicrotask(() => self.reply({
          type: 'styles-final',
          payload: {
            styleIds: new Uint32Array(FINAL_STYLE_IDS),
            styleColors: new Uint8Array(FINAL_STYLE_IDS.length * 4).fill(128),
            styleFinishes: new Float32Array(FINAL_STYLE_FINISHES),
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
      if (msg.type === 'stream-chunk') {
        self.reply({ type: 'batch', meshes: [] });
        self.reply({ type: 'slice-done', seq: msg.seq });
      } else if (msg.type === 'stream-end') {
        self.reply({ type: 'complete', totalMeshes: 0 });
      }
    });
    created.push(worker);
    return worker;
  }) as unknown as typeof Worker;
}

async function runToCompletion(): Promise<StreamingGeometryEvent[]> {
  const shared = new SharedArrayBuffer(8 * 1024 * 1024);
  const gen = processParallel(new Uint8Array(shared), new CoordinateHandler(), undefined, shared, {
    workerCountOverride: 2,
  });
  const events: StreamingGeometryEvent[] = [];
  const drain = (async () => {
    for await (const event of gen) events.push(event);
  })();
  await vi.advanceTimersByTimeAsync(5_000);
  await Promise.race([drain, new Promise((resolve) => setTimeout(resolve, 0))]);
  return events;
}

describe('processParallel sharded pre-pass #5582 finishes', () => {
  it('merges slice finishes with the colour winner, finalizes with them, and broadcasts styleFinishes', async () => {
    installWorkers();
    const events = await runToCompletion();
    expect(events.some((e) => e.type === 'complete')).toBe(true);

    const finalize = created.flatMap((w) => w.received).find((m) => m.type === 'finalize-styles');
    expect(finalize, 'finalize-styles was dispatched').toBeDefined();
    expect(Array.from(finalize!.geomIds as Uint32Array)).toEqual([10, 11, 20]);
    const merged = finalize!.geomFinishes as Float32Array | undefined;
    expect(merged, 'finalize-styles carries the merged geomFinishes').toBeInstanceOf(Float32Array);
    // toEqual treats NaN as equal to NaN, so the empty claims are checked too.
    expect(Array.from(merged!)).toEqual([NaN, NaN, 0, 0.25, NaN, 0.75]);

    const setStyles = created.flatMap((w) => w.received).filter((m) => m.type === 'set-styles');
    expect(setStyles.length).toBeGreaterThanOrEqual(2);
    for (const msg of setStyles) {
      expect(Array.from(msg.styleIds as Uint32Array)).toEqual(FINAL_STYLE_IDS);
      expect(Array.from(msg.styleFinishes as Float32Array)).toEqual(FINAL_STYLE_FINISHES);
    }
  });
});
