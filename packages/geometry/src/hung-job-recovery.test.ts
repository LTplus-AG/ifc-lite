/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  readJobIfcType,
  SkippedHungElementsCollector,
  WorkerJobLedger,
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
    expect(plan.slices.map((s) => [ids(s.jobs), s.maxBatchJobs])).toEqual([
      [[3, 4], 1],
      [[5, 6], undefined],
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
      [[5], undefined],
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
