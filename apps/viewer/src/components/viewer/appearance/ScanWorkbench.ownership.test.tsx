/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { MeshData, GeometryResult } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { act } from 'react';
import { fixtureModel } from '@/test/store-fixture';
import { render, cleanup, click, waitFor, advance } from '@/test/render';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { modelAppearanceAssets } from '@/lib/appearance/model-assets';
import type { AppearanceWorker } from '@/lib/appearance/planner-worker-client';
import type { AppearanceWorkerRequest, AppearanceWorkerResponse } from '@/lib/appearance/planner-types';
import type { ScanRegistrationReport } from '@/lib/appearance/scan/types';
import { useScanWorkbench } from './useScanWorkbench';
import { useScanTransfer } from './useScanTransfer';
import { ScanTransferFields } from './ScanTransferFields';

const initial = useViewerStore.getState();
const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
afterEach(() => {
  cleanup(); mock.restoreAll(); useViewerStore.getState().clearAllMutations(); useViewerStore.setState(initial, true);
  if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor);
  else Reflect.deleteProperty(globalThis, 'Worker');
});
async function fixture() {
  const bytes = new TextEncoder().encode("ISO-10303-21;HEADER;FILE_DESCRIPTION(('lease'),'2;1');FILE_NAME('target.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;#10=IFCWALL('0Wall00000000000000001',$,'Original',$,$,$,$,$,.NOTDEFINED.);ENDSEC;END-ISO-10303-21;");
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const mesh: MeshData = { expressId: 1, positions: new Float32Array([0,0,0,1,0,0,0,1,0]), normals: new Float32Array(9), indices: new Uint32Array([0,1,2]), uvs: new Float32Array(6), color: [1,1,1,1], textureRef: { textureId: 1, url: 'source.png', repeatS: false, repeatT: false } };
  const bounds = { min: {x:0,y:0,z:0}, max: {x:1,y:1,z:0} };
  const geometry: GeometryResult = { meshes: [mesh], totalTriangles: 1, totalVertices: 3, coordinateInfo: { originShift: {x:0,y:0,z:0}, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } };
  const source: ReturnType<typeof fixtureModel> = { ...fixtureModel('source'), sourceFile: new File(['retained GLB'], 'source.glb'), geometryResult: geometry };
  const target: ReturnType<typeof fixtureModel> = { ...fixtureModel('target'), ifcDataStore: store, schemaVersion: 'IFC4', maxExpressId: 10, geometryResult: { ...geometry, meshes: [] } };
  useViewerStore.setState({ models: new Map([['source', source], ['target', target]]), activeModelId: 'target', editEnabled: true,
    mutationViews: new Map(), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationVersion: 0,
    modelPlacement: emptyPlacementState(), collabRoomId: null, sectionPlane: { ...initial.sectionPlane, enabled: false } });
  mock.method(modelAppearanceAssets, 'resolveImageAsset', () => 'retained-image');
  // The registration worker boundary returns a committed native report fixture.
  // These tests observe dispatch ownership and actual IFC edits, not solver output.
  const report = (JSON.parse(readFileSync(new URL('../../../../../../tests/fixtures/appearance/scan-alignment-workbench/good.json', import.meta.url), 'utf8')) as { result: { report: ScanRegistrationReport } }).result.report;
  class WorkerFixture implements AppearanceWorker {
    onmessage: AppearanceWorker['onmessage'] = null;
    onerror: AppearanceWorker['onerror'] = null;
    onmessageerror: AppearanceWorker['onmessageerror'] = null;
    terminate() {}
    postMessage(job: AppearanceWorkerRequest) {
      if (job.type !== 'scan-registration') throw new Error('Unexpected workbench fixture request');
      queueMicrotask(() => this.onmessage?.({ data: { type: 'scan-registration-complete', id: job.id, result: { ...report, sourceFrame: job.request.sourceFrame, targetFrame: job.request.targetFrame } } } as MessageEvent<AppearanceWorkerResponse>));
    }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: WorkerFixture });
}
for (const gesture of ['same-tick', 'cancel', 'unmount'] as const) test(`PR #9585: workbench ${gesture} owns direct appearance actions`, async () => {
  await fixture();
  let work: ReturnType<typeof useScanWorkbench> | undefined;
  let release!: () => void, finish!: () => void, actions = 0, published = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const finishing = new Promise<void>(resolve => { finish = resolve; });
  const jobs: Promise<void>[] = [];
  function Harness() {
    work = useScanWorkbench();
    const transfer = useScanTransfer(work);
    const apply = () => {
      jobs.push(work!.applyAppearance(async signal => {
        actions++;
        await held;
        signal.throwIfAborted();
        useViewerStore.getState().setAttribute('target', 10, 'Name', 'Applied');
        published = true;
        if (gesture === 'same-tick') await finishing;
      }));
    };
    return <><button onClick={() => void work!.calculate()}>Calculate fixture alignment</button>
      <button onClick={apply}>Direct appearance action</button><button onClick={() => work!.cancel()}>Cancel action</button>
      <output>{JSON.stringify(work.status)}</output><ScanTransferFields transfer={transfer} targetModelId="target" disabled={work.busy} /></>;
  }
  const ui = render(<Harness />);
  const button = (label: string) => [...ui.querySelectorAll('button')].find(item => item.textContent === label)!;
  await waitFor(() => !!work?.session && !work.busy, 'real workbench session prepared');
  click(button('Calculate fixture alignment'));
  await waitFor(() => !!work?.result && !work.busy, 'registration report adopted');
  try {
    act(() => { button('Direct appearance action').click(); if (gesture === 'same-tick') button('Direct appearance action').click(); });
    await waitFor(() => actions > 0, 'appearance action started');
    assert.equal(actions, 1, 'every caller shares the synchronous appearance lease');
    if (gesture === 'cancel') click(button('Cancel action'));
    if (gesture === 'unmount') cleanup();
  } finally {
    release();
    try {
      if (gesture === 'same-tick') {
        await waitFor(() => published, 'the owned action published its IFC edit');
        assert.equal(work!.stale, false, 'an owned publication cannot invalidate its own binding');
        assert.equal(work!.error, false);
      }
    } finally { await act(async () => { finish(); await Promise.all(jobs); }); }
  }
  await advance(10);
  assert.equal(useViewerStore.getState().undoStacks.get('target')?.length ?? 0, gesture === 'same-tick' ? 1 : 0);
  if (gesture === 'cancel') assert.match(ui.textContent ?? '', /appearanceCancelled/);
});
