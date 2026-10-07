/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scan detector (#6894) on the real wasm engine: one detection job turns
 * a seeded Y-up room into the expected proposals in the model frame, and the
 * worker client is latest-wins and cancellable. The worker is a stand-in that
 * runs the real job asynchronously, as a thread would, and records
 * terminations: cancelling a synchronous wasm call means terminating it.
 */

import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { ROOM, scanRoomSample } from '@/test/scan-room-fixture';
import type { ScanDetectWorkerRequest } from '@/workers/scanDetect.worker';
import { runScanDetectJob, type ScanDetectJob } from './detect-job';
import { createScanDetector } from './scan-detector';

/** Y-up sample -> IFC Z-up, plus a georeferenced offset. */
const SCAN_TO_MODEL = [1, 0, 0, 1000, 0, 0, -1, 2000, 0, 1, 0, 50, 0, 0, 0, 1];

let sample: Float32Array | null = null;
const job = (overrides: Partial<ScanDetectJob> = {}): ScanDetectJob => {
  sample ??= scanRoomSample();
  return { positions: sample, count: sample.length / 3, region: null, scanToModel: SCAN_TO_MODEL, schema: 'IFC4', ...overrides };
};

const posted: ScanDetectWorkerRequest[] = [];
let terminations = 0;

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private terminated = false;
  postMessage(message: ScanDetectWorkerRequest): void {
    posted.push(message);
    setTimeout(() => {
      if (this.terminated) return;
      const result = runScanDetectJob(message.job, (stage) => this.onmessage?.({ data: { type: 'progress', id: message.id, stage } } as MessageEvent));
      if (!this.terminated) this.onmessage?.({ data: { type: 'complete', id: message.id, result } } as MessageEvent);
    }, 5);
  }
  terminate(): void {
    this.terminated = true;
    terminations++;
  }
}

function withFakeWorker(t: TestContext): boolean {
  if (!ensureWasm(t)) return false;
  posted.length = 0;
  terminations = 0;
  const previous = (globalThis as { Worker?: unknown }).Worker;
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  t.after(() => {
    (globalThis as { Worker?: unknown }).Worker = previous;
  });
  return true;
}

describe('scan detector (#6894)', () => {
  it('detects the room in the model frame: four walls, floor, ceiling and the column', (t) => {
    if (!ensureWasm(t)) return;
    const stages: string[] = [];
    const result = runScanDetectJob(job(), (stage) => stages.push(stage));
    assert.deepEqual(stages, ['segmenting', 'proposing']);
    const classes = result.proposals.proposals.map((p) => p.ifcClass).sort();
    assert.deepEqual(classes, ['IfcColumn', 'IfcSlab', 'IfcSlab', 'IfcWall', 'IfcWall', 'IfcWall', 'IfcWall']);
    const column = result.proposals.proposals.find((p) => p.ifcClass === 'IfcColumn')!;
    assert.ok(column.geometry.kind === 'column');
    // Model frame: the room's (x, north) plus the offset; base snapped to the floor.
    assert.ok(Math.abs(column.geometry.base[0] - (1000 + ROOM.column.x)) < 0.02, `${column.geometry.base}`);
    assert.ok(Math.abs(column.geometry.base[1] - (2000 + ROOM.column.north)) < 0.02);
    assert.ok(Math.abs(column.geometry.base[2] - 50) < 0.03 && Math.abs(column.geometry.heightMetres - ROOM.height) < 0.03);
    assert.ok(Math.abs(column.geometry.radiusMetres - ROOM.column.radius) < 0.01);
    // Detections stay in the sample frame for the overlay: the floor is y = 0 there.
    const floor = result.planes.find((p) => Math.abs(p.normal[1]) > 0.99 && Math.abs(p.centroid[1]) < 0.05);
    assert.ok(floor, 'the floor plane, in the Y-up sample frame');
  });

  it('a section-box region limits detection to the points inside it', (t) => {
    if (!ensureWasm(t)) return;
    // Sample frame: only the west half (x < 2.4), floor to ceiling.
    const result = runScanDetectJob(job({ region: { min: [-1, -1, -5], max: [2.4, 3, 1] } }));
    assert.ok(result.segmentation.stats.outsideRegionPoints > 0);
    assert.equal(result.proposals.proposals.filter((p) => p.ifcClass === 'IfcColumn').length, 0, 'the column lies outside');
  });

  it('a new detection supersedes the running one by terminating its worker', async (t) => {
    if (!withFakeWorker(t)) return;
    const detector = createScanDetector();
    const first = detector.detect(job());
    const second = detector.detect(job({ schema: 'IFC2X3' }));
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 'superseded');
    assert.equal(b.status, 'done');
    assert.equal(terminations, 1, 'the first run was terminated, not left to finish');
    assert.equal(posted.length, 2);
    // Only the filled prefix is sent, as a copy (the cache keeps its buffer).
    assert.equal(posted[0].job.positions.length, job().count * 3);
    assert.notEqual(posted[0].job.positions, sample);
    detector.dispose();
  });

  it('cancel terminates the run and resolves it cancelled; the next detection runs on a fresh worker', async (t) => {
    if (!withFakeWorker(t)) return;
    const detector = createScanDetector();
    const stages: string[] = [];
    const running = detector.detect(job(), (stage) => stages.push(stage));
    detector.cancel();
    assert.equal((await running).status, 'cancelled');
    assert.equal(terminations, 1);
    const again = await detector.detect(job(), (stage) => stages.push(stage));
    assert.equal(again.status, 'done');
    assert.deepEqual(stages, ['segmenting', 'proposing'], 'the cancelled run reported no progress');
    detector.dispose();
  });

  it('the in-process fallback runs the same job and honours cancel', async (t) => {
    if (!ensureWasm(t)) return;
    const detector = createScanDetector({ inProcess: true });
    const cancelled = detector.detect(job());
    detector.cancel();
    assert.equal((await cancelled).status, 'cancelled');
    const done = await detector.detect(job());
    assert.ok(done.status === 'done');
    assert.equal(done.result.proposals.proposals.length, 7);
  });
});
