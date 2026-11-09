/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The store run slot's ownership contract: the record is the lease. Anything
 * that rewrites it (a newer begin, a cancel, a teardown patch) ends the lease,
 * aborts its signal and turns every later lease call into a no-op; the
 * activity journal row follows the record.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { create } from 'zustand';
import { cancelActivity, useActivityJournal } from '@/lib/activity/activity-journal';
import { createRunSlot, IDLE_RUN, type Run } from './run-slot';

type TestRun = Run<string, number, { model: string }, string>;

function slotOn(options: { journal?: boolean } = {}) {
  const store = create<{ job: TestRun; writes: number }>(() => ({ job: IDLE_RUN, writes: 0 }));
  const slot = createRunSlot<string, number, { model: string }, string>(
    {
      read: () => store.getState().job,
      write: (job) => store.setState((s) => ({ job, writes: s.writes + 1 })),
      subscribe: (listener) => store.subscribe(listener),
    },
    options.journal
      ? { begin: ({ model }) => ({ kind: 'check', title: 'activityTray.job.scanDetection', subject: model }), phase: (p) => `step ${p}` }
      : undefined,
  );
  return { store, slot, job: () => store.getState().job };
}

const rows = () => useActivityJournal.getState().jobs.map((job) => ({ outcome: job.outcome, subject: job.subject, phase: job.phase, detail: job.detail }));

afterEach(() => useActivityJournal.setState({ jobs: [] }));

describe('run slot leases', () => {
  it('a lease owns the record from begin to its own end', () => {
    const { slot, job } = slotOn();
    const lease = slot.begin({ model: 'a' });
    assert.deepEqual(job(), { kind: 'running', runId: lease.runId, owner: { model: 'a' } });
    assert.equal(lease.progress(1), true);
    assert.deepEqual(job(), { kind: 'running', runId: lease.runId, owner: { model: 'a' }, progress: 1 });
    assert.equal(lease.succeed('result'), true);
    assert.deepEqual(job(), { kind: 'succeeded', runId: lease.runId, result: 'result' });
    assert.equal(lease.signal.aborted, false, 'a success does not abort');
    assert.equal(lease.isCurrent(), false, 'an ended lease is no longer current');
    assert.equal(lease.fail('late'), false);
    assert.deepEqual(job(), { kind: 'succeeded', runId: lease.runId, result: 'result' });
  });

  it('a newer begin supersedes: the older lease aborts and every later call on it is a no-op', () => {
    const { store, slot, job } = slotOn();
    const older = slot.begin({ model: 'a' });
    const newer = slot.begin({ model: 'b' });
    assert.equal(older.signal.aborted, true);
    assert.equal(older.isCurrent(), false);
    assert.equal(newer.isCurrent(), true);
    const writes = store.getState().writes;
    assert.equal(older.progress(5), false);
    assert.equal(older.succeed('stale'), false);
    assert.equal(older.fail('stale'), false);
    assert.equal(older.cancel(), false);
    assert.equal(store.getState().writes, writes, 'a stale lease writes nothing');
    assert.deepEqual(job(), { kind: 'running', runId: newer.runId, owner: { model: 'b' } });
    assert.ok(newer.runId > older.runId);
  });

  it('a teardown patch writing the record idle invalidates the lease: abort, then refuse its result', () => {
    const { store, slot, job } = slotOn();
    const lease = slot.begin({ model: 'a' });
    store.setState({ job: IDLE_RUN }); // what a defineSliceTeardown arm returns
    assert.equal(lease.signal.aborted, true, 'the work is stopped, not only ignored');
    assert.equal(lease.isCurrent(), false);
    assert.equal(lease.succeed('late'), false);
    assert.deepEqual(job(), IDLE_RUN, 'the next session never sees the late result');
  });

  it('cancel ends the run cancelled and aborts it; slot.cancel reaches whoever is running', () => {
    const { slot, job } = slotOn();
    const lease = slot.begin({ model: 'a' });
    assert.equal(slot.cancel(), true);
    assert.equal(lease.signal.aborted, true);
    assert.deepEqual(job(), { kind: 'cancelled', runId: lease.runId });
    assert.equal(slot.cancel(), false, 'nothing left to cancel');
  });

  it('fail ends the run failed', () => {
    const { slot, job } = slotOn();
    const lease = slot.begin({ model: 'a' });
    assert.equal(lease.fail('boom'), true);
    assert.deepEqual(job(), { kind: 'failed', runId: lease.runId, error: 'boom' });
    assert.equal(lease.signal.aborted, true, 'leftover work of a failed run is stopped');
  });

  it('a scope that changed by succeed discards the result and ends the run cancelled', () => {
    const { slot, job } = slotOn();
    let world = 'w1';
    const lease = slot.begin({ model: 'a' }, { scopeIsCurrent: () => world === 'w1' });
    world = 'w2';
    assert.equal(lease.succeed('for w1'), false);
    assert.deepEqual(job(), { kind: 'cancelled', runId: lease.runId });
    assert.equal(lease.signal.aborted, true);
  });

  it('a binding that does not notify still cannot let a replaced lease write', () => {
    let record: TestRun = IDLE_RUN;
    const slot = createRunSlot<string, number, { model: string }, string>({
      read: () => record,
      write: (next) => { record = next; },
      subscribe: () => () => {},
    });
    const lease = slot.begin({ model: 'a' });
    record = IDLE_RUN; // torn down by a writer the slot never hears about
    assert.equal(lease.isCurrent(), false);
    assert.equal(lease.succeed('late'), false);
    assert.deepEqual(record, IDLE_RUN);
  });

  it('an unrelated store change leaves the lease alone', () => {
    const { store, slot } = slotOn();
    const lease = slot.begin({ model: 'a' });
    store.setState({ writes: 99 });
    assert.equal(lease.isCurrent(), true);
    assert.equal(lease.signal.aborted, false);
  });
});

describe('run slot activity mirror', () => {
  it('records begin, phase and success as one tray row', () => {
    const { slot } = slotOn({ journal: true });
    const lease = slot.begin({ model: 'scan.e57' });
    assert.deepEqual(rows(), [{ outcome: 'running', subject: 'scan.e57', phase: undefined, detail: undefined }]);
    lease.progress(2);
    assert.equal(rows()[0].phase, 'step 2');
    lease.succeed('ok');
    assert.deepEqual(rows(), [{ outcome: 'completed', subject: 'scan.e57', phase: undefined, detail: undefined }]);
  });

  it('a failure records its message; a teardown records cancelled', () => {
    const { store, slot } = slotOn({ journal: true });
    slot.begin({ model: 'a' }).fail('worker crashed');
    slot.begin({ model: 'b' });
    store.setState({ job: IDLE_RUN });
    assert.deepEqual(rows().map((row) => [row.subject, row.outcome, row.detail]), [['a', 'failed', 'worker crashed'], ['b', 'cancelled', undefined]]);
  });

  it("a superseded run's row ends cancelled, the newer run gets its own row", () => {
    const { slot } = slotOn({ journal: true });
    slot.begin({ model: 'a' });
    slot.begin({ model: 'b' });
    assert.deepEqual(rows().map((row) => [row.subject, row.outcome]), [['a', 'cancelled'], ['b', 'running']]);
  });

  it("the tray's Cancel cancels the lease it was recorded for, never a newer one", () => {
    const { slot, job } = slotOn({ journal: true });
    const older = slot.begin({ model: 'a' });
    const olderRow = useActivityJournal.getState().jobs[0].id;
    const newer = slot.begin({ model: 'b' });
    cancelActivity(olderRow); // a stale tray button: the row already ended
    assert.equal(newer.isCurrent(), true);
    const newerRow = useActivityJournal.getState().jobs[1].id;
    cancelActivity(newerRow);
    assert.equal(newer.signal.aborted, true);
    assert.deepEqual(job(), { kind: 'cancelled', runId: newer.runId });
    assert.equal(older.signal.aborted, true);
    assert.deepEqual(rows().map((row) => row.outcome), ['cancelled', 'cancelled']);
  });
});
