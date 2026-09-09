/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act, useState } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import type { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { fixtureModel } from '@/test/store-fixture';
import { cleanup, render, click, advance } from '@/test/render';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { appearanceAssets, modelAppearanceAssets } from '@/lib/appearance/model-assets';
import { prepareScanSession } from '@/lib/appearance/scan/session';
import type { ScanRegistrationReport, ScanRegistrationRequest } from '@/lib/appearance/scan/types';
import type { AppearanceWorkerRequest, AppearanceWorkerResponse } from '@/lib/appearance/planner-types';
import type { AppearanceWorker } from '@/lib/appearance/planner-worker-client';
import { useScanTransfer } from './useScanTransfer';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); mock.restoreAll(); setGlobalRendererRef({ current: null }); useViewerStore.setState(initial); appearanceAssets.clear(); });
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='), c => c.charCodeAt(0));
class HeldWorker implements AppearanceWorker {
  onmessage: AppearanceWorker['onmessage'] = null;
  onerror: AppearanceWorker['onerror'] = null;
  onmessageerror: AppearanceWorker['onmessageerror'] = null;
  message?: AppearanceWorkerRequest;
  late: AppearanceWorker['onmessage'] = null;
  terminated = 0;
  postMessage(message: AppearanceWorkerRequest) { this.message = message; this.late = this.onmessage; }
  terminate() { this.terminated++; }
  failLate() { this.late?.({ data: { type: 'error', id: this.message!.id, message: 'Late obsolete transfer failure' } } as MessageEvent<AppearanceWorkerResponse>); }
}
async function fixture() {
  const bytes = new TextEncoder().encode("ISO-10303-21;HEADER;FILE_DESCRIPTION(('transfer lifecycle'),'2;1');FILE_NAME('target.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;#10=IFCWALL('0Wall00000000000000001',$,'Target',$,$,$,$,$,.NOTDEFINED.);ENDSEC;END-ISO-10303-21;");
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const mesh: MeshData = { expressId: 1, geometryItemId: 3, positions: new Float32Array([0,0,0,1,0,0,0,1,0]), normals: new Float32Array(9), indices: new Uint32Array([0,1,2]), uvs: new Float32Array(6), color: [1,1,1,1], textureRef: { textureId: 1, url: 'source.png', repeatS: false, repeatT: false } };
  const bounds = { min: {x:0,y:0,z:0}, max: {x:1,y:1,z:0} };
  const coordinateInfo = { originShift: {x:0,y:0,z:0}, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false };
  const source: ReturnType<typeof fixtureModel> = { ...fixtureModel('source'), sourceFile: new File(['retained GLB'], 'source.glb'), geometryResult: { meshes: [mesh], totalTriangles: 1, totalVertices: 3, coordinateInfo } };
  const target: ReturnType<typeof fixtureModel> = { ...fixtureModel('target'), schemaVersion: 'IFC4' as const, ifcDataStore: store, geometryResult: { meshes: [{ ...mesh, expressId: 10, textureRef: undefined }], totalTriangles: 1, totalVertices: 3, coordinateInfo } };
  useViewerStore.setState({ models: new Map([['source', source], ['target', target]]), mutationViews: new Map(), mutationVersion: 0, modelPlacement: emptyPlacementState(), collabRoomId: null, sectionPlane: { ...initial.sectionPlane, enabled: false } });
  const asset = await appearanceAssets.add(png, { owner: { kind: 'source', id: 'fixture' } });
  mock.method(modelAppearanceAssets, 'resolveImageAsset', () => asset.id);
  mock.method(appearanceAssets, 'decode', async () => ({ width: 1, height: 1, close() {} } as ImageBitmap));
  const canvas = globalThis.OffscreenCanvas;
  Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, writable: true, value: class { getContext() { return { drawImage() {}, getImageData() { return { data: new Uint8ClampedArray([255,255,255,255]) }; } }; } } });
  const session = await prepareScanSession('source', 0, 'target', new AbortController().signal);
  const recorded = JSON.parse(readFileSync(new URL('../../../../../../docs/architecture/evidence/scan-alignment-workbench/good.json', import.meta.url), 'utf8')) as { result: { request: ScanRegistrationRequest; report: ScanRegistrationReport } };
  const result = { ...recorded.result, request: { ...recorded.result.request, sourceFrame: session.sourceFrame, targetFrame: session.targetFrame } };
  setGlobalRendererRef({ current: { hasActiveClipping: () => false } as Renderer });
  return { session, result, assetId: asset.id, restoreCanvas: () => Object.defineProperty(globalThis, 'OffscreenCanvas', { configurable: true, writable: true, value: canvas }) };
}
for (const reason of ['cancel', 'settings', 'stale', 'removed'] as const) test(`mounted transfer ${reason} stops pending work and ignores late completion #4381`, async () => {
  const f = await fixture(), workers: HeldWorker[] = [], descriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: class extends HeldWorker { constructor() { super(); workers.push(this); } } });
  let read: ReturnType<typeof useScanTransfer> | undefined;
  function Harness() {
    const [stale, setStale] = useState(false);
    const exists = useViewerStore(state => state.models.has('target'));
    const transfer = useScanTransfer({ targetId: 'target', session: f.session, result: f.result, stale: stale || !exists, busy: false, applyAppearance: async () => { throw new Error('No Apply is permitted in this pending-operation test'); } });
    read = transfer;
    return <><button onClick={() => { transfer.setProductIds([10]); transfer.setSettings(s => ({ ...s, reviewed: true })); }}>Choose</button><button onClick={() => void transfer.preview()}>Preview</button><button onClick={transfer.discard}>Cancel</button><button onClick={() => transfer.setSettings(s => ({ ...s, texelsPerMetre: s.texelsPerMetre + 1 }))}>Settings</button><button onClick={() => setStale(true)}>Stale</button><output>{transfer.status}</output></>;
  }
  try {
    const ui = render(<Harness />), button = (name: string) => [...ui.querySelectorAll('button')].find(b => b.textContent === name)!;
    click(button('Choose')); click(button('Preview'));
    for (let i = 0; i < 100 && !workers.some(w => w.message); i++) await advance(5);
    const worker = workers.find(w => w.message);
    assert.ok(worker?.message?.type === 'mesh-transfer', `real IFC snapshot, image readback and request preparation reached the worker: ${read?.status}`);
    appearanceAssets.release(f.assetId, { kind: 'source', id: 'fixture' });
    assert.ok(appearanceAssets.get(f.assetId), 'pending draft retains source pixels after source owner releases');
    if (reason === 'removed') act(() => useViewerStore.setState({ models: new Map() }));
    else click(button(reason === 'cancel' ? 'Cancel' : reason === 'settings' ? 'Settings' : 'Stale'));
    await advance(10);
    assert.equal(worker.terminated, 1);
    act(() => worker.failLate()); await advance(10);
    assert.equal(read!.ready, false);
    assert.equal(read!.coverage, null);
    assert.equal(appearanceAssets.get(f.assetId), undefined, 'obsolete preparation releases its last draft lease');
    assert.doesNotMatch(ui.textContent!, /Late obsolete/);
  } finally {
    cleanup(); f.restoreCanvas();
    if (descriptor) Object.defineProperty(globalThis, 'Worker', descriptor); else Reflect.deleteProperty(globalThis, 'Worker');
  }
});
