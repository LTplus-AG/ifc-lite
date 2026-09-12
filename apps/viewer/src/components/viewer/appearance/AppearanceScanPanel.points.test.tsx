/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { Renderer } from '@ifc-lite/renderer';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { cleanup, render } from '@/test/render';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { addPointsToScanCache, clearAllPointCloudScanCaches, getPointCloudScanSample, registerPointCloudScanCache, setPointCloudScanCacheOrigin } from '@/hooks/ingest/pointCloudScanCache';
import { prepareScanSession } from '@/lib/appearance/scan/session';
import { nativePointFromSample } from '@/lib/appearance/scan/point-source';
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
  const target: ReturnType<typeof fixtureModel> = { ...fixtureModel('target'), maxExpressId: 10, ifcDataStore: store, schemaVersion: 'IFC4' as const };
  const bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  const scan: ReturnType<typeof fixtureModel> = { ...fixtureModel('scan'), ifcDataStore: null, sourceFile: new File(['ply bytes'], 'room.ply'), pointCloudHandleId: HANDLE, loadState: 'complete',
    geometryResult: { meshes: [], pointClouds: [], totalTriangles: 0, totalVertices: 0, coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } } };
  registerPointCloudScanCache(HANDLE, 1000);
  setPointCloudScanCacheOrigin(HANDLE, [100, 200, 300]);
  // Native (Z-up) points 101..108 around the origin, delivered Y-up decode-relative like the ingest does.
  const native = Array.from({ length: 8 }, (_, i) => [100 + i, 200 + (i % 3), 300 + (i % 2)]);
  const positions = new Float32Array(native.flatMap(([x, y, z]) => [x - 100, z - 300, -(y - 200)]));
  addPointsToScanCache(HANDLE, { positions, colors: new Float32Array(native.flatMap((_, i) => [i / 8, 0.5, 1])), pointCount: 8 });
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
  assert.match(session.sourceFrame.frameKey, /^pointcloud-native-z-up-metres-v1:[a-f0-9]{64}$/);
  assert.match(session.targetFrame.frameKey, /^workspace-ifc-z-up-metres:/);
  native.forEach((point, i) => assert.deepEqual(nativePointFromSample(points, i).map(v => Math.round(v * 1e4) / 1e4), point));
  assert.doesNotThrow(() => session.validate());
  // Another chunk reaching the reservoir means the pinned sample no longer describes the live scan.
  addPointsToScanCache(HANDLE, { positions: new Float32Array([1, 1, 1]), pointCount: 1 });
  assert.throws(() => session.validate(), /frame changed/);
  assert.equal(getPointCloudScanSample(HANDLE)!.count, 9);
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
