/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `startScanDetection`'s lifetime (#6894): a run belongs to its scan. Removing
 * the scan (or every model) while the worker is still segmenting terminates
 * the worker and discards whatever it returns, so no run for a gone scan is
 * stored or drawn. A section box hidden by the visibility toggle does not
 * crop detection: the crop follows the visible cut (`activeSectionPlane`).
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { fixtureModel } from '@/test/store-fixture.js';
import { addPointsToScanCache, clearAllPointCloudScanCaches, registerPointCloudScanCache } from '@/hooks/ingest/pointCloudScanCache';
import { PointCloudRenderer, type Renderer } from '@ifc-lite/renderer';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { nativePointCloudOriginMatrix } from '@/hooks/ingest/pointCloudDecodeOrigin';
import type { ScanDetectJob, ScanDetectResult } from './detect-job';
import type { ScanDetectOutcome, ScanDetector } from './scan-detector';
import { startScanDetection, type DetectionDeps } from './run-detection';

const HANDLE = 77;
const initial = useViewerStore.getState();

/** A detector the test settles by hand; `cancel` is recorded, the late answer is still delivered. */
function heldDetector() {
  const jobs: ScanDetectJob[] = [];
  const stages: Array<((stage: 'segmenting' | 'proposing') => void) | undefined> = [];
  let settle: ((outcome: ScanDetectOutcome) => void) | null = null;
  let cancels = 0;
  const detector: ScanDetector = {
    detect: (job, onStage) => { jobs.push(job); stages.push(onStage); return new Promise((resolve) => { settle = resolve; }); },
    cancel: () => { cancels++; },
    dispose: () => {},
  };
  return { detector, jobs, stages, cancels: () => cancels, answer: (outcome: ScanDetectOutcome) => settle?.(outcome) };
}

const RESULT: ScanDetectResult = {
  planes: [],
  cylinders: [],
  segmentation: { stats: {} as ScanDetectResult['segmentation']['stats'], limits: {} as ScanDetectResult['segmentation']['limits'] },
  proposals: { algorithm: 'test', proposals: [], transformScale: 1, stats: {} as ScanDetectResult['proposals']['stats'] },
};

function seed(): void {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  registerPointCloudScanCache(HANDLE, 4);
  addPointsToScanCache(HANDLE, { positions, normalState: 'absent', pointCount: 4 });
  const scan = { ...fixtureModel('scan', { idOffset: 0 }), name: 'room.e57', ifcDataStore: undefined, pointCloudHandleId: HANDLE } as unknown as FederatedModel;
  const other = fixtureModel('other', { idOffset: 100_000 });
  const ifc = fixtureModel('ifc', { idOffset: 200_000 });
  (ifc.ifcDataStore as { schemaVersion?: string }).schemaVersion = 'IFC4';
  useViewerStore.setState({ models: new Map([['scan', scan], ['other', other], ['ifc', ifc]]), activeModelId: 'ifc' });
}

afterEach(() => {
  setGlobalRendererRef({ current: null });
  clearAllPointCloudScanCaches();
  useViewerStore.setState(initial, true);
});

describe('startScanDetection lifetime (#6894)', () => {
  for (const how of ['the scan is removed', 'the IFC target is removed', 'every model is cleared'] as const) {
    it(`when ${how} mid-detection, the worker is terminated and its answer discarded`, async () => {
      seed();
      const held = heldDetector();
      const deps: DetectionDeps = { detector: () => held.detector, cloudMatrix: () => null };
      const running = startScanDetection('scan', deps);
      assert.equal(useViewerStore.getState().scanDetectionStatus, 'running');
      if (how === 'the scan is removed') useViewerStore.getState().removeModel('scan');
      else if (how === 'the IFC target is removed') useViewerStore.getState().removeModel('ifc');
      else useViewerStore.getState().clearAllModels();
      assert.equal(held.cancels(), 1, 'the running worker is terminated');
      assert.equal(useViewerStore.getState().scanDetectionStatus, 'idle', 'no run is in flight any more');
      // The worker answers anyway (it raced the terminate): nothing is stored.
      held.answer({ status: 'done', result: RESULT });
      await running;
      assert.equal(useViewerStore.getState().scanDetectionRun, null, 'no run for a scan or target that is gone');
      assert.equal(useViewerStore.getState().scanDetectionStatus, 'idle');
    });
  }

  it('a progress report from an abandoned run does not touch the status', async () => {
    seed();
    const held = heldDetector();
    const running = startScanDetection('scan', { detector: () => held.detector, cloudMatrix: () => null });
    useViewerStore.getState().removeModel('scan');
    assert.equal(useViewerStore.getState().scanDetectionStage, null);
    // The terminated worker's last progress message was already in flight.
    held.stages[0]?.('proposing');
    assert.equal(useViewerStore.getState().scanDetectionStage, null, 'a gone run reports no stage');
    held.answer({ status: 'cancelled' });
    await running;
  });

  it('a finished run stops watching its models: removing the scan afterwards cancels nothing', async () => {
    seed();
    const held = heldDetector();
    const running = startScanDetection('scan', { detector: () => held.detector, cloudMatrix: () => null });
    held.answer({ status: 'done', result: RESULT });
    await running;
    // A leaked subscription would treat this as an abandoned in-flight run and cancel the worker.
    useViewerStore.getState().removeModel('scan');
    assert.equal(held.cancels(), 0, 'no listener outlives its run');
    assert.equal(useViewerStore.getState().scanDetectionRun, null, 'the finished run ends with its scan (teardown)');
  });

  it('removing another model leaves the run alone', async () => {
    seed();
    const held = heldDetector();
    const running = startScanDetection('scan', { detector: () => held.detector, cloudMatrix: () => null });
    useViewerStore.getState().removeModel('other');
    assert.equal(held.cancels(), 0);
    held.answer({ status: 'done', result: RESULT });
    await running;
    assert.equal(useViewerStore.getState().scanDetectionRun?.sourceModelId, 'scan');
  });

  it('a section box hidden by the visibility toggle does not crop detection; a visible one does', async () => {
    seed();
    const box = { min: [0, 0, 0] as [number, number, number], max: [0.5, 0.5, 0.5] as [number, number, number] };
    const s = useViewerStore.getState();
    useViewerStore.setState({ sectionPlane: { ...s.sectionPlane, enabled: true, box }, sceneState: { ...s.sceneState, section: { ...s.sceneState.section, visible: false } } });
    const held = heldDetector();
    const deps: DetectionDeps = { detector: () => held.detector, cloudMatrix: () => null };
    let running = startScanDetection('scan', deps);
    held.answer({ status: 'done', result: RESULT });
    await running;
    assert.equal(held.jobs[0].region, null, 'hidden cut: the whole sample');
    const t = useViewerStore.getState();
    useViewerStore.setState({ sceneState: { ...t.sceneState, section: { ...t.sceneState.section, visible: true } } });
    running = startScanDetection('scan', deps);
    held.answer({ status: 'done', result: RESULT });
    await running;
    assert.deepEqual(held.jobs[1].region, { min: [0, 0, 0], max: [0.5, 0.5, 0.5] }, 'visible cut: the box');
    assert.equal(useViewerStore.getState().scanDetectionRun?.cropped, true);
  });
});

/** A real point cloud renderer (stub GPU device) behind the global renderer, as the viewport installs it. */
function mapGridScan(origin: readonly [number, number, number], ifcInfo?: unknown): { points: PointCloudRenderer; handleId: number } {
  const g = globalThis as Record<string, unknown>;
  g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 };
  g.GPUBufferUsage ??= { VERTEX: 32, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
  const device = { limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 }, createBindGroupLayout: () => ({}), createPipelineLayout: () => ({}),
    createShaderModule: () => ({}), createRenderPipeline: () => ({}), createBindGroup: () => ({}),
    createBuffer: ({ size }: { size: number }) => ({ size, destroy() {} }), queue: { writeBuffer() {} } } as unknown as GPUDevice;
  const points = new PointCloudRenderer(device, 'rgba8unorm', 'depth32float', 1);
  // Decode-relative sample (a 4 m square around the scan's bbox centre), placed at its native map origin.
  const sample = new Float32Array([-2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2, 0, 2.5, 0]);
  const handle = points.addAsset({ expressId: 1, modelIndex: 0, chunk: { pointCount: 5, positions: sample, bbox: { min: [-2, 0, -2], max: [2, 2.5, 2] } } });
  points.setAssetTransform(handle, nativePointCloudOriginMatrix(origin));
  const renderer = {
    getPointCloudTransform: (h: { id: number }) => points.getAssetTransform(h),
    getPointCloudPlacement: (h: { id: number }) => points.getAssetPlacement(h),
  } as unknown as Renderer;
  setGlobalRendererRef({ current: renderer });
  registerPointCloudScanCache(handle.id, 5);
  addPointsToScanCache(handle.id, { positions: sample, normalState: 'absent', pointCount: 5 });
  const scan = { ...fixtureModel('scan', { idOffset: 0 }), loadedAt: 2, name: 'map.e57', ifcDataStore: undefined, pointCloudHandleId: handle.id } as unknown as FederatedModel;
  const ifc = { ...fixtureModel('ifc', { idOffset: 100_000 }), loadedAt: 1, ...(ifcInfo ? { geometryResult: { meshes: [], totalTriangles: 0, totalVertices: 0, coordinateInfo: ifcInfo } } : {}) } as unknown as FederatedModel;
  useViewerStore.setState({ models: new Map([['ifc', ifc], ['scan', scan]]), activeModelId: 'ifc' });
  return { points, handleId: handle.id };
}

describe('the detection frame at map-grid origins is float64 (#6894)', () => {
  // A georeferenced scan at native map coordinates beside a blank (non-georeferenced) IFC model:
  // the "create a blank model" flow. The decode origin is the scan's bbox centre.
  for (const [name, origin] of [['LV95', [2_600_000.37, 1_200_000.83, 410.21]], ['UTM', [500_000.37, 5_300_000.83, 300.21]]] as const) {
    it(`${name}: the detection frame carries the scan's native origin exactly`, async () => {
      mapGridScan(origin);
      const held = heldDetector();
      // Only the detector is replaced: the cloud matrix comes from the production renderer path.
      const running = startScanDetection('scan', { detector: () => held.detector });
      held.answer({ status: 'done', result: RESULT });
      await running;
      const frame = held.jobs[0].scanToModel;
      // Sample (0, 0, 0) lands on the native origin, Z up: E, N, H.
      for (const [entry, expected] of [[3, origin[0]], [7, origin[1]], [11, origin[2]]] as const) {
        assert.ok(Math.abs(frame[entry] - expected) < 1e-6, `scanToModel[${entry}] ${frame[entry]} vs ${expected}`);
      }
      const run = useViewerStore.getState().scanDetectionRun!;
      assert.ok(Math.abs(run.cloudMatrix![12] - origin[0]) < 1e-6 && Math.abs(run.cloudMatrix![14] + origin[1]) < 1e-6, 'the overlay maps through the exact placement too');
    });
  }
});
