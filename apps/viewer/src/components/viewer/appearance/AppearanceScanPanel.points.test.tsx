/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { Renderer } from '@ifc-lite/renderer';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PlyStreamingSource } from '@ifc-lite/pointcloud';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { cleanup, render } from '@/test/render';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { addPointsToScanCache, clearAllPointCloudScanCaches, getPointCloudScanSample } from '@/hooks/ingest/pointCloudScanCache';
import { ingestPointCloud } from '@/hooks/ingest/pointCloudIngest';
import { prepareScanSession } from '@/lib/appearance/scan/session';
import { nativePointFromSample, pointTransferPayload } from '@/lib/appearance/scan/point-source';
import { prepareMeshTransfer, transferSource } from '@/lib/appearance/scan/prepare-transfer';
import { createAppearancePlanner, type AppearanceWorker } from '@/lib/appearance/planner-worker-client';
import type { AppearanceWorkerRequest } from '@/lib/appearance/planner-types';
import type { ScanCorrespondence, ScanRegistrationRequest } from '@/lib/appearance/scan/types';
import type { MeshTransferRequest } from '@/lib/appearance/scan/transfer-types';
import { AppearanceScanPanel } from './AppearanceScanPanel';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); mock.restoreAll(); clearAllPointCloudScanCaches(); useViewerStore.setState(initial); });
const HANDLE = 41;

/** A streamed point cloud as the ingest leaves it: a finished reservoir keyed by
 * the renderer handle, the decode origin recorded, the model registered with
 * `pointCloudHandleId` and no meshes. */
async function fixture() {
  const bytes = new TextEncoder().encode("ISO-10303-21;HEADER;FILE_DESCRIPTION(('point alignment'),'2;1');FILE_NAME('target.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;#10=IFCWALL('0Wall00000000000000001',$,'Wall',$,$,$,$,$,.NOTDEFINED.);ENDSEC;END-ISO-10303-21;");
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const emptyGeometry = { meshes: [], pointClouds: [], totalTriangles: 0, totalVertices: 0,
    coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
  const target: ReturnType<typeof fixtureModel> = { ...fixtureModel('target'), maxExpressId: 10, ifcDataStore: store,
    schemaVersion: 'IFC4' as const, geometryResult: emptyGeometry };
  const native = Array.from({ length: 8 }, (_, i) => [100 + i, 200 + (i % 3), 300 + (i % 2)]);
  const ply = 'ply\nformat ascii 1.0\nelement vertex 8\nproperty float x\nproperty float y\nproperty float z\n'
    + 'property uchar red\nproperty uchar green\nproperty uchar blue\nproperty float nx\nproperty float ny\nproperty float nz\nend_header\n'
    + native.map(([x, y, z], i) => `${x} ${y} ${z} ${i * 20} 128 255 ${i + 1} ${i + 2} ${i + 3}`).join('\n') + '\n';
  const scanFile = new File([ply], 'room.ply');
  const scan: ReturnType<typeof fixtureModel> = { ...fixtureModel('scan'), ifcDataStore: null, sourceFile: scanFile, pointCloudHandleId: HANDLE, loadState: 'complete',
    geometryResult: emptyGeometry };
  const ingestRenderer = new Renderer(document.createElement('canvas'));
  mock.method(ingestRenderer, 'beginPointCloudStream', () => ({ id: HANDLE }));
  mock.method(ingestRenderer, 'setPointCloudTransform', () => {});
  mock.method(ingestRenderer, 'appendPointCloudChunk', () => {});
  mock.method(ingestRenderer, 'requestRender', () => {});
  mock.method(ingestRenderer, 'endPointCloudStream', () => {});
  mock.method(ingestRenderer, 'removePointCloudAsset', () => {});
  const loaded = ingestPointCloud({ format: 'ply', blob: scanFile, fileName: scanFile.name,
    fileSize: scanFile.size, renderer: ingestRenderer, maxScanCachePoints: 1000,
    createSource: options => new PlyStreamingSource(options.blob, { downsample: { stride: options.stride ?? 1 }, originOffset: options.originOffset }) });
  await loaded.done;
  useViewerStore.setState({ models: new Map([['scan', scan], ['target', target]]), mutationViews: new Map([['target', new MutablePropertyView(store.properties, 'target')]]), mutationVersion: 0, modelPlacement: emptyPlacementState(), collabRoomId: null, sectionPlane: { ...initial.sectionPlane, enabled: false } });
  return { scan, target, native };
}

test('a completely streamed point cloud is offered as a scan source with its retained count, in the file frame (#4381)', async () => {
  const { native } = await fixture();
  const session = await prepareScanSession('scan', 'points', 'target', new AbortController().signal);
  assert.equal(session.source.kind, 'points');
  if (session.source.kind !== 'points') throw new Error('unreachable');
  const { points } = session.source;
  assert.equal(points.count, 8);
  assert.equal(points.normalState, 'supplied');
  const planned = transferSource(session.source, { toleranceMetres: 0.01, reviewed: true, texelsPerMetre: 64,
    maxDistanceMetres: 0.02, minNormalDot: 0.8, ambiguityDistanceMetres: 0.001, maxBehindMetres: 0.01,
    neighborhoodRadiusMetres: 0.03, minNeighbors: 4, maxNeighbors: 32, surfaceBandMetres: 0.003 }).source;
  assert.equal(planned.kind === 'points' && planned.orientation, 'source-normals');
  assert.match(session.sourceFrame.frameKey, /^pointcloud-native-z-up-metres-v1:[a-f0-9]{64}$/);
  assert.match(session.targetFrame.frameKey, /^workspace-ifc-z-up-metres:/);
  native.forEach((point, i) => assert.deepEqual(nativePointFromSample(points, i).map(v => Math.round(v * 1e4) / 1e4), point));
  let delivered: AppearanceWorkerRequest | undefined;
  const worker: AppearanceWorker = {
    onmessage: null, onerror: null, onmessageerror: null,
    postMessage(message) { delivered = structuredClone(message); },
    terminate() {},
  };
  const planner = createAppearancePlanner({ workerFactory: () => worker });
  const controller = new AbortController();
  const request: MeshTransferRequest = { schema: 'IFC4', sourceRevision: session.revision, nextExpressId: session.nextExpressId,
    productIds: [10], registration: { sourceFrame: session.sourceFrame, targetFrame: session.targetFrame, fit: [], heldOut: [] },
    registrationSha256: 'a'.repeat(64), targetFromIfcWorld: { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], sourceAnchor: [0, 0, 0], targetAnchor: [0, 0, 0] },
    source: planned, sourceImages: [], texelsPerMetre: 64, maxDistanceMetres: 0.02, minNormalDot: 0.8,
    ambiguityDistanceMetres: 0.001, maxBehindMetres: 0.01 };
  const pending = planner.pointTransfer(session.bytes, request, new Uint8Array(0),
    { ...pointTransferPayload(points), stations: new Uint32Array(0) }, { signal: controller.signal });
  assert.equal(delivered?.type, 'point-transfer');
  if (delivered?.type !== 'point-transfer') throw new Error('point transfer did not reach the planner worker');
  assert.equal(delivered.request.source.kind === 'points' && delivered.request.source.orientation, 'source-normals');
  assert.equal(delivered.points.normals.length, 24);
  assert.deepEqual(Array.from(delivered.points.normals.slice(0, 3)).map(v => Math.round(v * 1e6) / 1e6),
    [1, 2, 3].map(v => v / Math.sqrt(14)).map(v => Math.round(v * 1e6) / 1e6));
  assert.deepEqual(Array.from(delivered.points.positions.slice(0, 3)), native[0]);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  planner.dispose();
  assert.doesNotThrow(() => session.validate());
  // Another chunk reaching the reservoir means the pinned sample no longer describes the live scan.
  addPointsToScanCache(HANDLE, { positions: new Float32Array([1, 1, 1]), normalState: 'absent', pointCount: 1 });
  assert.throws(() => session.validate(), /frame changed/);
  assert.equal(getPointCloudScanSample(HANDLE)!.count, 9);
});

test('the bounded PLY ingest completes the Rust planner with retained source normals (#4561)', async t => {
  const wasmUrl = new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  try { await access(wasmUrl); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    t.skip('Build WASM with pnpm build:wasm to run the completed point-transfer journey'); return;
  }
  const { native } = await fixture();
  const session = await prepareScanSession('scan', 'points', 'target', new AbortController().signal);
  if (session.source.kind !== 'points') throw new Error('fixture did not retain its streamed PLY');
  const { default: init, IfcAPI } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(wasmUrl) });
  const { runPointTransfer } = await import('@/workers/appearance.worker');
  const api = new IfcAPI();
  const pairs: ScanCorrespondence[] = native.map((point, index) => ({ id: `p${index}`, sourceObservation: `point:${index}:seen:8`,
    targetFeature: `target-${index}`, source: [point[0], point[1], point[2]], target: [point[0], point[1], point[2]] }));
  const registration: ScanRegistrationRequest = { sourceFrame: session.sourceFrame, targetFrame: session.targetFrame, fit: pairs.slice(0, 4), heldOut: pairs.slice(4) };
  try {
    const report = JSON.parse(new TextDecoder().decode(api.registerScanCorrespondences(JSON.stringify(registration)))) as import('@/lib/appearance/scan/types').ScanRegistrationReport;
    const settings = { toleranceMetres: 0.01, reviewed: true, texelsPerMetre: 64, maxDistanceMetres: 0.02,
      minNormalDot: 0.8, ambiguityDistanceMetres: 0.001, maxBehindMetres: 0.01,
      neighborhoodRadiusMetres: 0.03, minNeighbors: 4, maxNeighbors: 32, surfaceBandMetres: 0.003 };
    let deliveredRows = 0;
    const worker: AppearanceWorker = { onmessage: null, onerror: null, onmessageerror: null, terminate() {}, postMessage(message) {
      if (message.type !== 'point-transfer') throw new Error(`unexpected planner job ${message.type}`);
      deliveredRows = message.points.normals.length / 3;
      void runPointTransfer(message.source, message.request, message.rgba, message.points).then(result => {
        worker.onmessage?.({ data: { type: 'mesh-transfer-complete', id: message.id, result } } as MessageEvent);
      }, error => worker.onerror?.({ message: error instanceof Error ? error.message : String(error) } as ErrorEvent));
    } };
    const planner = createAppearancePlanner({ workerFactory: () => worker });
    try {
      const result = await prepareMeshTransfer(session, { request: registration, report }, [10], settings, planner,
        { kind: 'draft', id: 'ply-normal-journey' }, new AbortController().signal);
      assert.equal(deliveredRows, 8);
      assert.deepEqual(result.transfer.source, { kind: 'points', orientation: 'source-normals', pointCount: 8 });
    } finally { planner.dispose(); }
  } finally { api.free(); }
});

test('the workbench lists the point cloud and mounts the point preview through the real session, not a GLB path (#4381)', async () => {
  await fixture();
  const stream = { begin: 0, appended: 0, ended: 0 };
  mock.method(Renderer.prototype, 'init', async () => {});
  mock.method(Renderer.prototype, 'beginPointCloudStream', () => { stream.begin++; return { id: 1 }; });
  mock.method(Renderer.prototype, 'appendPointCloudChunk', (_handle: unknown, chunk: { pointCount: number }) => { stream.appended += chunk.pointCount; });
  mock.method(Renderer.prototype, 'endPointCloudStream', () => { stream.ended++; });
  mock.method(Renderer.prototype, 'fitToView', () => {});
  mock.method(Renderer.prototype, 'render', () => {});
  const ui = render(<AppearanceScanPanel />);
  const select = ui.querySelector('select')!;
  assert.equal(select.value, 'scan:points');
  assert.match(select.options[1].textContent!, /Point cloud \(8 of 8 points retained\)/);
  for (let i = 0; i < 100 && !ui.querySelector('canvas'); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const canvas = ui.querySelector('canvas');
  assert.ok(canvas, 'point preview mounted');
  assert.equal(canvas.getAttribute('aria-label'), 'Scan landmark preview');
  for (let i = 0; i < 50 && stream.ended === 0; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.deepEqual(stream, { begin: 1, appended: 8, ended: 1 }, 'the retained sample is uploaded once to the local preview renderer');
  assert.match(ui.textContent!, /Click a scan point, then its matching point in the main IFC view/);
});

test('a point cloud whose stream failed or kept no sample is not offered (#4381)', async () => {
  const { scan, target } = await fixture();
  useViewerStore.setState({ models: new Map([['scan', { ...scan, loadState: 'error' }], ['target', target]]) });
  await assert.rejects(prepareScanSession('scan', 'points', 'target', new AbortController().signal), /completely streamed/);
  useViewerStore.setState({ models: new Map([['scan', { ...scan, pointCloudHandleId: 99 }], ['target', target]]) });
  await assert.rejects(prepareScanSession('scan', 'points', 'target', new AbortController().signal), /no retained sample/);
  const ui = render(<AppearanceScanPanel />);
  assert.equal(ui.querySelector('select')!.options.length, 1, 'no source option without a retained sample');
});
