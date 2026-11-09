/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * J1: the activity-journal row a model load leaves behind says what happened
 * to that load. Only a user cancel (or a superseding load) reads
 * `cancelled`; a load that ends without a model and without a cancel failed;
 * a resource retry hands the row over to the retry instead of reading as a
 * cancel of its own.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getViewerStoreApi } from '@/store';
import { useActivityJournal } from '@/lib/activity/activity-journal';
import { createModelLoadActivity, handOffToRetry, installModelLoadCanceller } from './modelLoadCanceller.js';

const store = getViewerStoreApi();
const jobs = () => useActivityJournal.getState().jobs;

afterEach(() => {
  const s = store.getState();
  s.setActiveLoadCanceller(null);
  s.resetViewerState();
  s.clearAllModels();
  sessionStorage.clear();
  useActivityJournal.setState({ jobs: [] });
});

describe('model load activity outcome (J1)', () => {
  it('J1: a load that ends with no model, no error and no cancel is recorded failed, not cancelled', () => {
    const release = installModelLoadCanceller('primary', () => {}, () => null, createModelLoadActivity('tower.ifc'));
    release();
    const [job] = jobs();
    assert.equal(job.outcome, 'failed');
    assert.ok(job.detail || job.detailKey, 'the row says why');
  });

  it('J1: a user Cancel still records cancelled', () => {
    const release = installModelLoadCanceller('primary', () => {}, () => null, createModelLoadActivity('tower.ifc'));
    store.getState().activeLoadCanceller?.();
    release();
    assert.equal(jobs()[0].outcome, 'cancelled');
  });

  it('J1: a retained run Cancel-interrupted before it published anything records cancelled', () => {
    const activity = createModelLoadActivity('tower.ifc');
    activity.interrupt = () => {};
    const release = installModelLoadCanceller('primary', () => {}, () => null, activity);
    store.getState().activeLoadCanceller?.();
    activity.interrupt = undefined;
    release();
    assert.equal(jobs()[0].outcome, 'cancelled');
  });

  it('J1: a retained run Cancel-interrupted after it published records completed', () => {
    const activity = createModelLoadActivity('tower.ifc');
    activity.interrupt = () => {};
    const release = installModelLoadCanceller('primary', () => {}, () => null, activity);
    store.getState().activeLoadCanceller?.();
    activity.published = true;
    release();
    assert.equal(jobs()[0].outcome, 'completed');
  });

  it('J1: a resource retry hands the file over; the first attempt does not read as a cancel', () => {
    const first = createModelLoadActivity('tower.ifc');
    const releaseFirst = installModelLoadCanceller('primary', () => {}, () => null, first);
    first.handOff(); // the retry now owns the outcome
    const retry = createModelLoadActivity('tower.ifc');
    const releaseRetry = installModelLoadCanceller('primary', () => {}, () => null, retry);
    releaseFirst();
    assert.deepEqual(jobs().map((job) => job.outcome), ['running'], 'only the retry is listed');
    retry.published = true;
    releaseRetry();
    assert.deepEqual(jobs().map((job) => [job.subject, job.outcome]), [['tower.ifc', 'completed']]);
  });

  it('J1: a load superseded by a new primary load (not a retry) still records cancelled', () => {
    const releaseFirst = installModelLoadCanceller('primary', () => {}, () => null, createModelLoadActivity('a.ifc'));
    const releaseSecond = installModelLoadCanceller('primary', () => {}, () => null, createModelLoadActivity('b.ifc'));
    releaseFirst();
    assert.deepEqual(jobs().map((job) => [job.subject, job.outcome]), [['a.ifc', 'cancelled'], ['b.ifc', 'running']]);
    releaseSecond();
  });

  it('J1: the loader\'s resource retry leaves only the retry\'s row, settled by the retry', async () => {
    const first = createModelLoadActivity('tower.ifc');
    const releaseFirst = installModelLoadCanceller('primary', () => {}, () => null, first);
    // What useIfcLoader's tryResourceRetry runs: the retry is a new primary load of the same file.
    await handOffToRetry(first, async () => {
      const retry = createModelLoadActivity('tower.ifc');
      const releaseRetry = installModelLoadCanceller('primary', () => {}, () => null, retry);
      assert.deepEqual(jobs().map((job) => [job.subject, job.outcome]), [['tower.ifc', 'running']], 'the attempt\'s row is gone once the retry runs');
      retry.published = true;
      releaseRetry();
    });
    releaseFirst(); // the attempt's own finally
    assert.deepEqual(jobs().map((job) => [job.subject, job.outcome]), [['tower.ifc', 'completed']]);
  });

  it('J1: with no retry to run, the attempt keeps and settles its own row', async () => {
    const first = createModelLoadActivity('tower.ifc');
    const releaseFirst = installModelLoadCanceller('primary', () => {}, () => null, first);
    await handOffToRetry(first, undefined);
    releaseFirst();
    assert.deepEqual(jobs().map((job) => job.outcome), ['failed']);
  });
});
