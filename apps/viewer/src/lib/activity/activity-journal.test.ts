/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The activity journal across a reload (U02, #6925; charter: "ephemeral
 * running jobs return as interrupted, not magically completed"). A reload is
 * simulated the way it happens: the in-memory store and cancel handles are
 * gone, only this tab's `sessionStorage` record survives.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIVITY_LIMIT, ACTIVITY_STORAGE_KEY, activityCanceller, beginActivity, cancelActivity, clearFinishedActivity,
  finishActivity, restoreActivityJournal, updateActivity, useActivityJournal,
} from './activity-journal.js';
import { isCataloguedKey } from './activity-recorders.js';

const T0 = 1_760_000_000_000;

function reload(): void {
  useActivityJournal.setState({ jobs: [] });
}

afterEach(() => {
  sessionStorage.clear();
  reload();
});

describe('activity journal (U02, #6925)', () => {
  it('a job still running at reload comes back interrupted, never completed', () => {
    const running = beginActivity({ kind: 'check', title: 'activityTray.job.clash', panel: 'clash', cancel: () => {} }, T0);
    const done = beginActivity({ kind: 'export', title: 'activityTray.job.export', subject: 'Export IFC' }, T0 + 1);
    finishActivity(done, 'completed', {}, T0 + 2);

    reload();
    assert.equal(restoreActivityJournal(isCataloguedKey), 1, 'one job was cut off');
    const jobs = useActivityJournal.getState().jobs;
    assert.deepEqual(jobs.map((job) => [job.id, job.outcome]), [[running, 'interrupted'], [done, 'completed']]);
    assert.equal(activityCanceller(running), null, 'a restored job cannot be cancelled: nothing is running');
    assert.equal(jobs[0].panel, 'clash', 'it still opens the panel that owns its artifact');
  });

  it('a late finish cannot complete an interrupted job', () => {
    const id = beginActivity({ kind: 'flow', title: 'activityTray.job.flow' }, T0);
    reload();
    restoreActivityJournal(isCataloguedKey);
    finishActivity(id, 'completed');
    updateActivity(id, { phase: 'late' });
    const [job] = useActivityJournal.getState().jobs;
    assert.equal(job.outcome, 'interrupted');
    assert.equal(job.phase, undefined);
  });

  it('drops malformed or uncatalogued records instead of rendering them', () => {
    sessionStorage.setItem(ACTIVITY_STORAGE_KEY, JSON.stringify([
      { id: 'ok', kind: 'export', title: 'activityTray.job.export', startedAt: T0, outcome: 'completed' },
      { id: 'bad-title', kind: 'export', title: 'not.a.key', startedAt: T0, outcome: 'completed' },
      { id: 'bad-kind', kind: 'mine', title: 'activityTray.job.export', startedAt: T0, outcome: 'completed' },
      { id: 'bad-panel', kind: 'load', title: 'activityTray.job.load', startedAt: T0, outcome: 'failed', panel: 'nope' },
      'garbage',
    ]));
    restoreActivityJournal(isCataloguedKey);
    const jobs = useActivityJournal.getState().jobs;
    assert.deepEqual(jobs.map((job) => job.id), ['ok', 'bad-panel']);
    assert.equal(jobs[1].panel, undefined, 'an unknown panel id is dropped, the job kept');
  });

  it('an unreadable record starts empty with a warning', () => {
    sessionStorage.setItem(ACTIVITY_STORAGE_KEY, '{not json');
    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args[0]); };
    try {
      assert.equal(restoreActivityJournal(isCataloguedKey), 0);
    } finally {
      console.warn = warn;
    }
    assert.equal(useActivityJournal.getState().jobs.length, 0);
    assert.equal(warnings.length, 1);
  });

  it('keeps the newest jobs within the limit', () => {
    for (let i = 0; i < ACTIVITY_LIMIT + 5; i++) beginActivity({ kind: 'export', title: 'activityTray.job.export', id: `job-${i}` }, T0 + i);
    const jobs = useActivityJournal.getState().jobs;
    assert.equal(jobs.length, ACTIVITY_LIMIT);
    assert.equal(jobs[0].id, 'job-5');
  });

  it('evicts finished jobs before a running one, which keeps its Cancel (PR #6952 review)', () => {
    let cancelled = 0;
    const live = beginActivity({ kind: 'load', title: 'activityTray.job.load', id: 'live', cancel: () => { cancelled++; } }, T0);
    for (let i = 0; i < ACTIVITY_LIMIT + 5; i++) {
      const id = beginActivity({ kind: 'export', title: 'activityTray.job.export', id: `done-${i}` }, T0 + 1 + i);
      finishActivity(id, 'completed', {}, T0 + 1 + i);
    }
    const jobs = useActivityJournal.getState().jobs;
    assert.equal(jobs.length, ACTIVITY_LIMIT);
    assert.ok(jobs.some((job) => job.id === live && job.outcome === 'running'), 'the oldest job is running, so it stays');
    assert.equal(jobs.at(-1)?.id, `done-${ACTIVITY_LIMIT + 4}`, 'the newest finished job is kept');
    cancelActivity(live);
    assert.equal(cancelled, 1, 'and it can still be cancelled');
  });

  it('a running job evicted by more running jobs drops its Cancel handle', () => {
    let stale = 0;
    beginActivity({ kind: 'ai', title: 'activityTray.job.ai', id: 'oldest', cancel: () => { stale++; } }, T0);
    for (let i = 0; i < ACTIVITY_LIMIT; i++) beginActivity({ kind: 'ai', title: 'activityTray.job.ai', id: `req-${i}` }, T0 + 1 + i);
    assert.equal(useActivityJournal.getState().jobs.some((job) => job.id === 'oldest'), false, 'evicted');
    // The same id comes back (a source id reused) with no cancel of its own:
    // the evicted job's handle must not be offered for it.
    beginActivity({ kind: 'ai', title: 'activityTray.job.ai', id: 'oldest' }, T0 + 100);
    assert.equal(activityCanceller('oldest'), null);
    assert.equal(stale, 0);
  });

  it('cancels through the source and clears only finished jobs', () => {
    let cancelled = 0;
    const live = beginActivity({ kind: 'load', title: 'activityTray.job.load', cancel: () => { cancelled++; } }, T0);
    const old = beginActivity({ kind: 'export', title: 'activityTray.job.export' }, T0);
    finishActivity(old, 'failed', { detail: 'disk full' }, T0 + 1);
    cancelActivity(live);
    assert.equal(cancelled, 1);
    clearFinishedActivity();
    assert.deepEqual(useActivityJournal.getState().jobs.map((job) => job.id), [live]);
  });
});
