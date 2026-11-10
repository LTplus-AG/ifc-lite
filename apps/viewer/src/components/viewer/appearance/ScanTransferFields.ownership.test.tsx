/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useEffect, useState } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { AppearancePreviewController } from '../../../../../../packages/renderer/src/appearance-preview';
import { fixtureModel } from '@/test/store-fixture';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { render, cleanup, click, advance } from '@/test/render';
import { useViewerStore } from '@/store';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { appearanceAssets, modelAppearanceAssets } from '@/lib/appearance/model-assets';
import { prepareScanSession } from '@/lib/appearance/scan/session';
import type { ScanPoint, ScanRegistrationRequest } from '@/lib/appearance/scan/types';
import type { AppearanceWorker } from '@/lib/appearance/planner-worker-client';
import type { AppearanceWorkerRequest, AppearanceWorkerResponse } from '@/lib/appearance/planner-types';
import { runMeshTransfer, runScanRegistration } from '@/workers/appearance.worker';
import { useScanTransfer } from './useScanTransfer';
import { ScanTransferFields } from './ScanTransferFields';
const initial = useViewerStore.getState();
const descriptors = ['Worker', 'OffscreenCanvas'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
afterEach(() => {
  cleanup(); useViewerStore.getState().clearAllMutations(); setGlobalRendererRef({ current: null });
  useViewerStore.setState(initial, true); modelAppearanceAssets.clear(); appearanceAssets.clear();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
  }
});
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
const source = `ISO-10303-21;HEADER;FILE_DESCRIPTION(('scan ownership'),'2;1');FILE_NAME('target.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,(#6),#3);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#3=IFCUNITASSIGNMENT((#2));
#4=IFCCARTESIANPOINT((0.,0.,0.));#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#5,$);
#10=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#11=IFCTRIANGULATEDFACESET(#10,$,.F.,((1,2,3)),$);
#23=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#11));#24=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#25=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000a',$,'Target',$,$,$,#24,$,.NOTDEFINED.);
ENDSEC;END-ISO-10303-21;`;
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 200 && !predicate(); i++) await advance(10);
  assert.ok(predicate(), message);
}
for (const gesture of ['preview', 'apply', 'unmount'] as const) test(`scan transfer ${gesture} retains one native operation (PR #9585)`, async t => {
  if (!ensureWasm(t)) return;
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(source).buffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(store.properties, 'target'), editor = new StoreEditor(store, view);
  const indices = new Uint32Array([0, 1, 2]);
  const targetMesh: MeshData = { expressId: 25, geometryItemId: 11, positions: new Float32Array([0,0,0,1,0,0,0,0,-1]),
    normals: new Float32Array([0,1,0,0,1,0,0,1,0]), indices, color: [1,1,1,1],
    appearanceSource: { kind: 'canonical-item', indices, sourceIndices: indices } };
  const scanMesh: MeshData = { ...targetMesh, expressId: 1, uvs: new Float32Array([0,0,1,0,0,1]),
    textureRef: { textureId: 1, url: 'source.png', repeatS: false, repeatT: false } };
  const bounds = { min: {x:0,y:0,z:-1}, max: {x:1,y:0,z:0} };
  const geometry: GeometryResult = { meshes: [targetMesh], totalTriangles: 1, totalVertices: 3,
    coordinateInfo: { originShift: {x:0,y:0,z:0}, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
  const target = { ...fixtureModel('target'), loadedAt: 1, ifcDataStore: store, schemaVersion: 'IFC4' as const, maxExpressId: 25, geometryResult: geometry };
  const scan = { ...fixtureModel('source', { idOffset: 1_000_000 }), loadedAt: 2, sourceFile: new File(['retained source'], 'scan.glb'),
    geometryResult: { ...geometry, meshes: [scanMesh] } };
  useViewerStore.setState({ models: new Map([['target', target], ['source', scan]]), activeModelId: 'target',
    ifcDataStore: store, geometryResult: geometry, editEnabled: true, mutationViews: new Map([['target', view]]), storeEditors: new Map([['target', editor]]),
    undoStacks: new Map(), redoStacks: new Map(), mutationVersion: 0, modelPlacement: emptyPlacementState(), collabRoomId: null,
    selectedEntityId: 25, selectedEntityIds: new Set([25]), sectionPlane: { ...initial.sectionPlane, enabled: false } });
  const asset = await appearanceAssets.add(png, { owner: { kind: 'source', id: 'scan-ownership' } });
  t.mock.method(modelAppearanceAssets, 'resolveImageAsset', () => asset.id);
  t.mock.method(appearanceAssets, 'decode', async (id: string) => {
    const image = appearanceAssets.get(id)!;
    return { width: image.width, height: image.height, close() {} } as ImageBitmap;
  });
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, value: class {
    getContext() { return { drawImage() {}, getImageData() { return { data: new Uint8ClampedArray([255,255,255,255]) }; } }; }
  } });
  let parts: readonly MeshData[] = [targetMesh], previews = 0;
  const gpu = new AppearancePreviewController<number>({ capture: () => ({ parts, resources: [0] }),
    stage: () => [1], install: (_owner, next) => { parts = next; }, release() {} });
  setGlobalRendererRef({ current: { hasActiveClipping: () => false, getAppearancePreview: () => gpu,
    getScene: () => ({ getMeshDataPieces: () => parts }), requestRender() {} } as unknown as Renderer });
  class NativeWorker implements AppearanceWorker {
    onmessage: AppearanceWorker['onmessage'] = null; onerror: AppearanceWorker['onerror'] = null; onmessageerror: AppearanceWorker['onmessageerror'] = null;
    dead = false;
    terminate() { this.dead = true; }
    postMessage(job: AppearanceWorkerRequest) {
      if (job.type !== 'mesh-transfer') throw new Error('Unexpected scan job');
      previews++;
      void runMeshTransfer(job.source, job.request, job.rgba).then(result => {
        if (!this.dead) this.onmessage?.({ data: { type: 'mesh-transfer-complete', id: job.id, result } } as MessageEvent<AppearanceWorkerResponse>);
      }, error => { if (!this.dead) this.onerror?.({ message: String(error) } as ErrorEvent); });
    }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: NativeWorker });
  const session = await prepareScanSession('source', 0, 'target', new AbortController().signal);
  const point = (x: number, y: number): ScanPoint => [x, 0, -y];
  const fit = [point(0,0), point(1,0), point(0,1), point(0.2,0.2)];
  const check = [point(0.1,0.1), point(0.2,0.2), point(0.3,0.1), point(0.1,0.3)];
  const rows = (points: ScanPoint[], prefix: string) => points.map((p, i) => ({ id: `${prefix}${i}`, sourceObservation: `${prefix}s${i}`, targetFeature: `${prefix}t${i}`, source: p, target: [p[0], -p[2], p[1]] as ScanPoint }));
  const request: ScanRegistrationRequest = { sourceFrame: session.sourceFrame, targetFrame: session.targetFrame, fit: rows(fit, 'f'), heldOut: rows(check, 'c') };
  const result = { request, report: await runScanRegistration(request) };
  const controllers: AbortController[] = [], jobs: Promise<void>[] = [], failures: string[] = [];
  let preparations = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const prepare = editor.prepareEntityOperations.bind(editor);
  t.mock.method(editor, 'prepareEntityOperations', async (...args: Parameters<typeof prepare>) => { preparations++; await held; return prepare(...args); });
  function Harness() {
    const [busy, setBusy] = useState(false);
    useEffect(() => () => { for (const controller of controllers) controller.abort(); }, []);
    const transfer = useScanTransfer({ targetId: 'target', session, result, stale: false, busy,
      applyAppearance: async action => {
        const controller = new AbortController(); controllers.push(controller); setBusy(true);
        const job = action(controller.signal).catch(error => { failures.push(String(error)); }).finally(() => setBusy(false));
        jobs.push(job); await job;
      } });
    return <ScanTransferFields transfer={transfer} targetModelId="target" disabled={busy} />;
  }
  const ui = render(<Harness />);
  const button = (name: string) => { const found = [...ui.querySelectorAll('button')].find(item => item.textContent?.startsWith(name)); assert.ok(!!found, name); return found!; };
  click(button('Use selected IFC object'));
  const reviewed = [...ui.querySelectorAll('label')].find(label => label.textContent?.includes('I reviewed'))?.querySelector('input');
  assert.ok(!!reviewed, 'review checkbox'); click(reviewed!);
  const preview = button('Preview transfer');
  act(() => { preview.click(); if (gesture === 'preview') preview.click(); });
  await until(() => !![...ui.querySelectorAll('button')].find(item => item.textContent === 'Apply scan appearance'), ui.textContent ?? 'native preview');
  if (gesture === 'preview') { assert.equal(previews, 1, 'only one native preview per press burst'); return; }
  act(() => useViewerStore.getState().setActiveModel('source'));
  let unsubscribe = () => {};
  if (gesture === 'unmount') {
    const version = useViewerStore.getState().mutationVersion; let queued = false;
    unsubscribe = useViewerStore.subscribe(state => { if (!queued && state.mutationVersion > version) { queued = true; queueMicrotask(cleanup); } });
  }
  try {
    const apply = button('Apply scan appearance');
    act(() => { apply.click(); if (gesture === 'apply') apply.click(); });
    await until(() => preparations > 0, 'detached preparation');
    act(() => useViewerStore.setState({ selectedEntityId: null, selectedEntityIds: new Set() }));
    assert.equal(controllers.every(controller => !controller.signal.aborted), true, '3D selection does not cancel pinned scan targets');
    assert.equal(preparations, 1, 'only one detached Apply per press burst');
  } finally { await act(async () => { release(); await Promise.all(jobs); }); unsubscribe(); }
  assert.equal(failures.length, 0, failures.join('\n'));
  assert.equal(useViewerStore.getState().undoStacks.get('target')?.length, 1);
  if (gesture === 'unmount') assert.equal(useViewerStore.getState().activeModelId, 'source', 'closed transfer cannot switch active model');
});
