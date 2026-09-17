/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_HUNG_JOB_RECOVERIES,
  readJobIfcType,
  SkippedHungElementsCollector,
  startHungJobMonitor,
  WorkerJobLedger,
  type HungJobPool,
} from './hung-job-recovery.js';

/** Flat `[id, start, end]` triples for ids with dummy spans. */
function jobs(...ids: number[]): Uint32Array {
  return new Uint32Array(ids.flatMap((id) => [id, id * 10, id * 10 + 5]));
}

function ids(flat: Uint32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < flat.length; i += 3) out.push(flat[i]);
  return out;
}

describe('WorkerJobLedger (#4884)', () => {
  it('flags only a worker that is inside a call and silent past the budget', () => {
    const ledger = new WorkerJobLedger(2, 0);
    const seq = ledger.recordDispatch(0, jobs(1, 2));
    ledger.recordDispatch(1, jobs(3));
    ledger.onCallStart(0, seq, 0, 2, 100);
    // Worker 1 was dispatched work but never started a call: it may still be
    // installing state, so silence alone is not a hang.
    expect(ledger.findHung(30_099, 30_000)).toEqual([]);
    expect(ledger.findHung(30_100, 30_000)).toEqual([0]);
  });

  it('gives a single-job call twice the budget before it may be skipped, so a merely slow element survives', () => {
    const ledger = new WorkerJobLedger(1, 0);
    const seq = ledger.recordDispatch(0, jobs(1), 1);
    ledger.onCallStart(0, seq, 0, 1, 0);
    // 45 s: past the old 40 s single-call allowance, still inside the grace.
    expect(ledger.findHung(45_000, 30_000)).toEqual([]);
    // Liveness is reported from 2/3 of the budget until the call is recoverable.
    expect(ledger.needsLiveness(45_000, 30_000)).toBe(true);
    expect(ledger.needsLiveness(19_999, 30_000)).toBe(false);
    expect(ledger.findHung(60_000, 30_000)).toEqual([0]);
    expect(ledger.needsLiveness(60_000, 30_000)).toBe(false);
  });

  it('stops considering a worker busy once its slice is done', () => {
    const ledger = new WorkerJobLedger(1, 0);
    const seq = ledger.recordDispatch(0, jobs(1));
    ledger.onCallStart(0, seq, 0, 1, 10);
    ledger.onSliceDone(0, seq, 20);
    expect(ledger.findHung(1_000_000, 30_000)).toEqual([]);
    expect(ledger.takeRecoveryPlan(0, 0)).toEqual({ skippedJob: null, slices: [] });
  });

  it('skips the job of a hung single-job call and replays the rest of the slice and later slices', () => {
    const ledger = new WorkerJobLedger(1, 0);
    const first = ledger.recordDispatch(0, jobs(1, 2, 3, 4), 1);
    ledger.recordDispatch(0, jobs(5, 6));
    ledger.onCallStart(0, first, 0, 1, 1);
    ledger.onCallStart(0, first, 1, 1, 2); // job 1 returned; job 2 never does

    const plan = ledger.takeRecoveryPlan(0, 3);
    expect(plan.skippedJob && ids(plan.skippedJob)).toEqual([2]);
    // The later slice was uncapped; it replays at the learned size (1 job).
    expect(plan.slices.map((s) => [ids(s.jobs), s.maxBatchJobs])).toEqual([
      [[3, 4], 1],
      [[5, 6], 1],
    ]);
  });

  it('re-runs a hung multi-job call one job per call instead of skipping anything', () => {
    const ledger = new WorkerJobLedger(1, 0);
    const seq = ledger.recordDispatch(0, jobs(1, 2, 3, 4, 5));
    ledger.onCallStart(0, seq, 0, 2, 1); // jobs 1-2 returned (flushed before the next call)
    ledger.onCallStart(0, seq, 2, 2, 2); // jobs 3-4 never return

    const plan = ledger.takeRecoveryPlan(0, 3);
    expect(plan.skippedJob).toBeNull();
    expect(plan.slices.map((s) => [ids(s.jobs), s.maxBatchJobs])).toEqual([
      [[3, 4], 1],
      [[5], 2],
    ]);
  });

  it('drops slices a later call proves finished and resets the slot for the replacement', () => {
    const ledger = new WorkerJobLedger(1, 0);
    ledger.recordDispatch(0, jobs(1));
    const second = ledger.recordDispatch(0, jobs(2, 3));
    ledger.onCallStart(0, second, 0, 2, 5);
    const plan = ledger.takeRecoveryPlan(0, 6);
    expect(plan.slices.map((s) => ids(s.jobs))).toEqual([[2, 3]]);
    expect(ledger.findHung(1_000_000, 1)).toEqual([]);
  });

  it('replays unfinished slices at the worker\'s learned batch size, not the restart maximum', () => {
    const ledger = new WorkerJobLedger(1, 0);
    const seq = ledger.recordDispatch(0, jobs(1, 2, 3, 4, 5, 6));
    const later = ledger.recordDispatch(0, jobs(7, 8));
    ledger.onCallStart(0, seq, 0, 3, 1); // a 3-job call returned
    ledger.onCallStart(0, seq, 3, 1, 2); // job 4 hangs
    const plan = ledger.takeRecoveryPlan(0, 3);
    expect(ids(plan.skippedJob!)).toEqual([4]);
    expect(plan.slices.map((s) => [ids(s.jobs), s.maxBatchJobs])).toEqual([
      [[5, 6], 3],
      [[7, 8], 3],
    ]);
    expect(later).toBeGreaterThan(seq);
  });

  it('retains nothing to replay when recovery is disabled', () => {
    const ledger = new WorkerJobLedger(1, 0, false);
    const seq = ledger.recordDispatch(0, jobs(1, 2));
    ledger.onCallStart(0, seq, 0, 2, 1);
    expect(ledger.takeRecoveryPlan(0, 2)).toEqual({ skippedJob: null, slices: [] });
  });

  it('keeps its own copy of a dispatched slice, so transferring the original is safe', () => {
    const ledger = new WorkerJobLedger(1, 0);
    const original = jobs(7);
    const seq = ledger.recordDispatch(0, original);
    original.fill(0);
    ledger.onCallStart(0, seq, 0, 1, 1);
    expect(ids(ledger.takeRecoveryPlan(0, 2).skippedJob!)).toEqual([7]);
  });
});

describe('readJobIfcType (#4884)', () => {
  const source = new TextEncoder().encode("#12= IfcWallStandardCase('x');#13=IFCBEAM($);#14=nonsense;");

  it('reads the entity keyword the job spans, upper-cased', () => {
    expect(readJobIfcType(source, new Uint32Array([12, 0, 30]))).toBe('IFCWALLSTANDARDCASE');
    expect(readJobIfcType(source, new Uint32Array([13, 30, 45]))).toBe('IFCBEAM');
  });

  it('never reports anything that is not an IFC keyword', () => {
    expect(readJobIfcType(source, new Uint32Array([14, 45, 60]))).toBe('UNKNOWN');
    expect(readJobIfcType(source, new Uint32Array([99, 500, 600]))).toBe('UNKNOWN');
  });
});

describe('SkippedHungElementsCollector (#4884)', () => {
  it('reports nothing when nothing was skipped', () => {
    expect(new SkippedHungElementsCollector().report()).toBeUndefined();
  });

  it('groups skipped elements by type, count-desc then keyword-asc', () => {
    const source = new TextEncoder().encode('#1=IFCSLAB();#2=IFCBEAM();#3=IFCBEAM();');
    const collector = new SkippedHungElementsCollector();
    collector.add(source, new Uint32Array([1, 0, 13]));
    collector.add(source, new Uint32Array([2, 13, 26]));
    collector.add(source, new Uint32Array([3, 26, 39]));
    expect(collector.report()).toEqual({
      expressIds: [1, 2, 3],
      byType: [
        { ifcType: 'IFCBEAM', count: 2 },
        { ifcType: 'IFCSLAB', count: 1 },
      ],
    });
  });
});

describe('startHungJobMonitor (#4884)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  class StubWorker {
    readonly received: unknown[] = [];
    terminated = false;
    postMessage(msg: unknown): void { this.received.push(msg); }
    terminate(): void { this.terminated = true; }
  }

  function pool(ledger: WorkerJobLedger, workers: StubWorker[]) {
    const events = { liveness: 0, replaced: 0, failed: [] as Error[] };
    const p: HungJobPool = {
      workers: workers as unknown as Worker[],
      ledger,
      makeWorker: () => {
        events.replaced++;
        return new StubWorker() as unknown as Worker;
      },
      installHandlers: () => {},
      setup: [],
      postChunk: (i, j, cap) => { (workers[i] as StubWorker).postMessage({ jobs: j, cap }); },
      streamEndSent: () => false,
      terminate: (w) => w.terminate(),
      source: new TextEncoder().encode('#1=IFCWALL();'),
      skipped: new SkippedHungElementsCollector(),
      isLive: () => true,
      onLiveness: () => { events.liveness++; },
      onFailed: (e) => { events.failed.push(e); },
    };
    return { p, events };
  }

  it('keeps the consumer alive during a single-job grace, then skips once the hang is seen on two ticks', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ledger = new WorkerJobLedger(1, performance.now());
    const seq = ledger.recordDispatch(0, new Uint32Array([1, 0, 13]), 1);
    ledger.onCallStart(0, seq, 0, 1, performance.now());
    const { p, events } = pool(ledger, [new StubWorker()]);
    const stop = startHungJobMonitor(p, 1_000); // ticks every 1 s; single-job budget 2 s

    vi.advanceTimersByTime(1_000);
    expect(events.liveness).toBe(1);
    vi.advanceTimersByTime(1_000); // past the budget: suspected, not yet replaced
    expect(events.replaced).toBe(0);
    vi.advanceTimersByTime(1_000); // still silent on the next tick: confirmed
    expect(events.replaced).toBe(1);
    expect(p.skipped.report()?.expressIds).toEqual([1]);
    stop();
  });

  it('does not replace a worker whose silence spans a host suspension', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const ledger = new WorkerJobLedger(1, clock);
    const seq = ledger.recordDispatch(0, new Uint32Array([1, 0, 13]), 1);
    ledger.onCallStart(0, seq, 0, 1, clock);
    const { p, events } = pool(ledger, [new StubWorker()]);
    const stop = startHungJobMonitor(p, 1_000);

    // The laptop sleeps for an hour; the worker's own messages are still queued.
    clock = 3_600_000;
    vi.advanceTimersByTime(1_000);
    clock += 1_000;
    vi.advanceTimersByTime(1_000);
    clock += 1_000;
    vi.advanceTimersByTime(1_000);
    expect(events.replaced).toBe(0);
    stop();
  });

  it('stops masking the consumer watchdog once the recovery cap is reached', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const workers = [new StubWorker()];
    const ledger = new WorkerJobLedger(1, performance.now());
    const { p, events } = pool(ledger, workers);
    const stop = startHungJobMonitor(p, 100);
    // Every replacement is handed one more single job that also hangs.
    for (let n = 0; n <= MAX_HUNG_JOB_RECOVERIES; n++) {
      const seq = ledger.recordDispatch(0, new Uint32Array([n + 1, 0, 13]), 1);
      ledger.onCallStart(0, seq, 0, 1, performance.now());
      vi.advanceTimersByTime(400);
    }
    expect(events.replaced).toBe(MAX_HUNG_JOB_RECOVERIES);
    const pulses = events.liveness;
    vi.advanceTimersByTime(10_000);
    expect(events.liveness).toBe(pulses);
    stop();
  });
});
