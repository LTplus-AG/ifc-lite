/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scan detection on the store run slot (implicit-state audit, section 2.1
 * pilot). The job record is the ownership, so every way a run can end
 * (a session reset, Cancel here or in the activity tray, a newer start, a
 * crashed worker, the model it read being replaced) terminates the worker,
 * refuses the late answer and settles the tray row the same way.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { fixtureModel } from '@/test/store-fixture.js';
import { installFakeWorker, interleave } from '@/test/race.js';
import { addPointsToScanCache, clearAllPointCloudScanCaches, registerPointCloudScanCache } from '@/hooks/ingest/pointCloudScanCache';
import { cancelActivity, useActivityJournal } from '@/lib/activity/activity-journal';
import type { ScanDetectJob, ScanDetectResult, ScanDetectStage } from './detect-job';
import { createScanDetector, type ScanDetectOutcome, type ScanDetector } from './scan-detector';
import { cancelScanDetection, startScanDetection, type DetectionDeps } from './run-detection';

const HANDLE = 91;
const initial = useViewerStore.getState();

const RESULT: ScanDetectResult = {
  planes: [],
  cylinders: [],
  segmentation: { stats: {} as ScanDetectResult['segmentation']['stats'], limits: {} as ScanDetectResult['segmentation']['limits'] },
  proposals: { algorithm: 'test', proposals: [], transformScale: 1, stats: {} as ScanDetectResult['proposals']['stats'] },
};

/** A detector the test answers by hand. `cancel` is counted; the answer is still deliverable after it (the race). */
function heldDetector() {
  const pending: Array<{ job: ScanDetectJob; onStage?: (stage: ScanDetectStage) => void; settle: (outcome: ScanDetectOutcome) => void }> = [];
  let cancels = 0;
  const detector: ScanDetector = {
    detect: (job, onStage) => new Promise((settle) => { pending.push({ job, onStage, settle }); }),
    cancel: () => { cancels++; },
    dispose: () => {},
  };
  const deps: DetectionDeps = { detector: () => detector, cloudMatrix: () => null };
  return { deps, pending, cancels: () => cancels };
}

function seed(): void {
  registerPointCloudScanCache(HANDLE, 4);
  addPointsToScanCache(HANDLE, { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), normalState: 'absent', pointCount: 4 });
  const scan = { ...fixtureModel('scan', { idOffset: 0 }), name: 'room.e57', ifcDataStore: undefined, pointCloudHandleId: HANDLE } as unknown as FederatedModel;
  const ifc = fixtureModel('ifc', { idOffset: 100_000 });
  (ifc.ifcDataStore as { schemaVersion?: string }).schemaVersion = 'IFC4';
  useViewerStore.setState({ models: new Map([['scan', scan], ['ifc', ifc]]), activeModelId: 'ifc' });
}

const job = () => useViewerStore.getState().scanDetectionJob;
const tray = () => useActivityJournal.getState().jobs.map((row) => ({ title: row.title, subject: row.subject, outcome: row.outcome, phase: row.phase, detail: row.detail, detailKey: row.detailKey }));

afterEach(() => {
  clearAllPointCloudScanCaches();
  useViewerStore.setState(initial, true);
  useActivityJournal.setState({ jobs: [] });
});

describe('scan detection run slot', () => {
  it('a session reset mid-detection terminates the worker and its late answer never reaches the new session', async () => {
    seed();
    const held = heldDetector();
    const running = startScanDetection('scan', held.deps);
    useViewerStore.getState().resetViewerState();
    assert.equal(held.cancels(), 1, 'the reset invalidates the run, it does not only reset a flag');
    assert.deepEqual(job(), { kind: 'idle' });
    held.pending[0].settle({ status: 'done', result: RESULT });
    await running;
    assert.equal(useViewerStore.getState().scanDetectionRun, null, 'the old session\'s result is not published');
    assert.deepEqual(job(), { kind: 'idle' });
    assert.deepEqual(tray().map((row) => row.outcome), ['cancelled']);
  });

  it('records the run in the activity tray: subject, live stage, completion', async () => {
    seed();
    const held = heldDetector();
    const running = startScanDetection('scan', held.deps);
    assert.deepEqual(tray(), [{ title: 'activityTray.job.scanDetection', subject: 'room.e57', outcome: 'running', phase: undefined, detail: undefined, detailKey: undefined }]);
    held.pending[0].onStage?.('segmenting');
    const live = job();
    assert.equal(live.kind === 'running' ? live.progress : null, 'segmenting');
    assert.equal(tray()[0].phase, 'segmenting');
    held.pending[0].settle({ status: 'done', result: RESULT });
    await running;
    assert.equal(job().kind, 'succeeded');
    assert.equal(useViewerStore.getState().scanDetectionRun?.sourceModelId, 'scan');
    assert.deepEqual(tray().map((row) => row.outcome), ['completed']);
  });

  it("the tray's Cancel terminates the worker and the run ends cancelled, the earlier result kept", async () => {
    seed();
    const held = heldDetector();
    let running = startScanDetection('scan', held.deps);
    held.pending[0].settle({ status: 'done', result: RESULT });
    await running;
    const reviewed = useViewerStore.getState().scanDetectionRun;
    running = startScanDetection('scan', held.deps);
    cancelActivity(useActivityJournal.getState().jobs[1].id);
    assert.equal(held.cancels(), 1);
    assert.equal(job().kind, 'cancelled');
    // The terminated worker's answer was already in flight.
    held.pending[1].settle({ status: 'done', result: RESULT });
    await running;
    assert.equal(job().kind, 'cancelled', 'a cancelled run does not come back as a success');
    assert.equal(useViewerStore.getState().scanDetectionRun, reviewed, 'the previous run stays reviewable');
    assert.deepEqual(tray().map((row) => row.outcome), ['completed', 'cancelled']);
  });

  it("the panel's Cancel is the same transition", async () => {
    seed();
    const held = heldDetector();
    const running = startScanDetection('scan', held.deps);
    cancelScanDetection();
    assert.equal(held.cancels(), 1);
    held.pending[0].settle({ status: 'cancelled' });
    await running;
    assert.equal(job().kind, 'cancelled');
    assert.deepEqual(tray().map((row) => row.outcome), ['cancelled']);
  });

  it('a detector that reports cancelled on its own ends the run instead of leaving it running', async () => {
    seed();
    const held = heldDetector();
    const running = startScanDetection('scan', held.deps);
    held.pending[0].settle({ status: 'cancelled' });
    await running;
    assert.equal(job().kind, 'cancelled', 'Detect elements is enabled again');
    assert.deepEqual(tray().map((row) => row.outcome), ['cancelled']);
  });

  it('a second start supersedes the first: one worker stop, the first answer refused, one row each', async () => {
    seed();
    const held = heldDetector();
    const first = startScanDetection('scan', held.deps);
    const second = startScanDetection('scan', held.deps);
    assert.equal(held.cancels(), 1, 'the first run is stopped before the second detect starts');
    const newer: ScanDetectResult = { ...RESULT, planes: [] };
    await interleave(
      () => held.pending[1].settle({ status: 'done', result: newer }),
      () => held.pending[0].settle({ status: 'done', result: RESULT }),
    );
    await Promise.all([first, second]);
    assert.equal(job().kind, 'succeeded');
    assert.ok(useViewerStore.getState().scanDetectionRun?.result === newer, 'the superseded answer landing last does not win');
    assert.deepEqual(tray().map((row) => row.outcome), ['cancelled', 'completed']);
  });

  it('a model replaced under the same id mid-run (a re-derived store) drops the result', async () => {
    seed();
    const held = heldDetector();
    const running = startScanDetection('scan', held.deps);
    const replaced = fixtureModel('ifc', { idOffset: 100_000 });
    useViewerStore.setState((s) => ({ models: new Map([...s.models, ['ifc', replaced]]) }));
    held.pending[0].settle({ status: 'done', result: RESULT });
    await running;
    assert.equal(useViewerStore.getState().scanDetectionRun, null, 'proposals framed for the replaced store are not published');
    assert.equal(job().kind, 'cancelled');
  });

  it('no sample is a failed run with the catalogued refusal, in the panel and the tray', async () => {
    useViewerStore.setState({ models: new Map([['scan', { ...fixtureModel('scan', { idOffset: 0 }), ifcDataStore: undefined, pointCloudHandleId: 404 } as unknown as FederatedModel]]) });
    await startScanDetection('scan', heldDetector().deps);
    const failed = job();
    assert.equal(failed.kind === 'failed' ? failed.error : null, 'noSample');
    assert.deepEqual(tray().map((row) => [row.outcome, row.detailKey, row.detail]), [['failed', 'scanToBim.error.noSample', undefined]]);
  });

  it('a crashed detection worker fails the run with its message', async () => {
    seed();
    const workers = installFakeWorker();
    const detector = createScanDetector();
    try {
      const running = startScanDetection('scan', { detector: () => detector, cloudMatrix: () => null });
      assert.equal(workers.latest().posted.length, 1, 'the job reached the worker');
      workers.latest().crash('out of memory');
      await running;
      const failed = job();
      assert.equal(failed.kind === 'failed' ? failed.error : null, 'out of memory');
      assert.deepEqual(tray().map((row) => [row.outcome, row.detail]), [['failed', 'out of memory']]);
    } finally {
      detector.dispose();
      workers.restore();
    }
  });
});
