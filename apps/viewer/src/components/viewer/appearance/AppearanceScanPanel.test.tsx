/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { render, cleanup } from '@/test/render';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { AppearanceScanPanel } from './AppearanceScanPanel';
afterEach(cleanup);

test('alignment source removal cannot substitute a different loaded scan (#4381)', () => {
  const mesh: MeshData = { expressId: 1, positions: new Float32Array([0,0,0,1,0,0,0,1,0]), normals: new Float32Array(9), indices: new Uint32Array([0,1,2]), uvs: new Float32Array(6), color: [1,1,1,1], textureRef: { textureId: 1, url: 'scan.png', repeatS: false, repeatT: false } };
  const bounds = { min: {x:0,y:0,z:0}, max: {x:1,y:1,z:0} };
  const source = (id: string) => ({ ...fixtureModel(id), sourceFile: new File(['source'], `${id}.glb`), geometryResult: { meshes: [mesh], totalTriangles: 1, totalVertices: 3, coordinateInfo: { originShift: {x:0,y:0,z:0}, originalBounds: bounds, shiftedBounds: bounds, hasLargeCoordinates: false } } });
  const first = source('first'), second = source('second');
  useViewerStore.setState({ models: new Map([['first', first], ['second', second]]), mutationViews: new Map(), mutationVersion: 0, modelPlacement: emptyPlacementState(), collabRoomId: null });
  const ui = render(<AppearanceScanPanel />);
  const select = ui.querySelector('select')!;
  assert.equal(select.value, 'first:0');
  act(() => useViewerStore.setState({ models: new Map([['second', second]]) }));
  assert.equal(select.value, '', 'missing pinned source is visibly unavailable');
  const calculate = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Calculate alignment')!;
  assert.equal(calculate.disabled, true);
  act(() => { select.value = 'second:0'; select.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.equal(select.value, 'second:0');
});

// Hold the real IFC serialization boundary so cancellation races completion.
// No renderer or registration result is fabricated by this test.
import { mock } from 'node:test';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { modelAppearanceAssets } from '@/lib/appearance/model-assets';
import { click } from '@/test/render';
afterEach(() => mock.restoreAll());

async function alignmentFixture() {
  const bytes = new TextEncoder().encode("ISO-10303-21;HEADER;FILE_DESCRIPTION(('alignment'),'2;1');FILE_NAME('target.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;#10=IFCWALL('0Wall00000000000000001',$,'Wall',$,$,$,$,$,.NOTDEFINED.);ENDSEC;END-ISO-10303-21;");
  const store = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const target: ReturnType<typeof fixtureModel> = { ...fixtureModel('target'), maxExpressId: 10, ifcDataStore: store, schemaVersion: 'IFC4' as const };
  const bounds = { min: {x:0,y:0,z:0}, max: {x:1,y:1,z:0} };
  const mesh: MeshData = { expressId: 1, positions: new Float32Array([0,0,0,1,0,0,0,1,0]), normals: new Float32Array(9), indices: new Uint32Array([0,1,2]), uvs: new Float32Array(6), color: [1,1,1,1], textureRef: { textureId: 1, url: 'scan.png', repeatS: false, repeatT: false } };
  const source: ReturnType<typeof fixtureModel> = { ...fixtureModel('source', { idOffset: 1_000_000 }), maxExpressId: 1, ifcDataStore: null, sourceFile: new File(['original GLB asset'], 'source.glb'), geometryResult: { meshes: [mesh], totalTriangles: 1, totalVertices: 3, coordinateInfo: {originShift:{x:0,y:0,z:0},originalBounds:bounds,shiftedBounds:bounds,hasLargeCoordinates:false} } };
  useViewerStore.setState({ models: new Map([['source', source], ['target', target]]), mutationViews: new Map([['target', new MutablePropertyView(store.properties, 'target')]]), mutationVersion: 0, modelPlacement: emptyPlacementState(), collabRoomId: null });
  mock.method(modelAppearanceAssets, 'resolveImageAsset', () => 'retained-image');
  return { source, target, mesh };
}

test('cancelling frame preparation cannot publish its late completed session (#4381)', async () => {
  await alignmentFixture();
  const original = StepExporter.prototype.exportAsync;
  let entered = false, finish: () => void = () => {};
  const gate = new Promise<void>(resolve => { finish = resolve; });
  mock.method(StepExporter.prototype, 'exportAsync', async function(this: StepExporter, ...args: Parameters<StepExporter['exportAsync']>) { entered = true; await gate; return original.apply(this, args); });
  const ui = render(<AppearanceScanPanel />);
  for (let i = 0; i < 50 && !entered; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.equal(entered, true, 'actual source hashing reached IFC serialization');
  click([...ui.querySelectorAll('button')].find(button => button.textContent === 'Cancel')!);
  await act(async () => { finish(); await new Promise(resolve => setTimeout(resolve, 30)); });
  assert.match(ui.textContent!, /cancelled/);
  assert.equal(ui.querySelector('canvas'), null, 'late preparation cannot mount a preview');
  assert.ok([...ui.querySelectorAll('button')].some(button => button.textContent === 'Restart with current models'));
});

import { prepareScanSession } from '@/lib/appearance/scan/session';
test('visibility preserves a frozen alignment but source geometry replacement invalidates it (#4381)', async () => {
  const { source, target } = await alignmentFixture();
  const session = await prepareScanSession('source', 0, 'target', new AbortController().signal);
  useViewerStore.setState({ models: new Map([['source', { ...source, visible: false }], ['target', target]]) });
  assert.doesNotThrow(() => session.validate());
  useViewerStore.setState({ models: new Map([['source', { ...source, visible: true }], ['target', target]]) });
  assert.doesNotThrow(() => session.validate());
  useViewerStore.setState({ models: new Map([['source', { ...source, geometryResult: { ...source.geometryResult!, meshes: [...source.geometryResult!.meshes] } }], ['target', target]]) });
  assert.throws(() => session.validate(), /frame changed/);
});

test('active section clipping refuses alignment before a preview can be published (#4381)', async () => {
  await alignmentFixture();
  const section = useViewerStore.getState().sectionPlane;
  useViewerStore.setState({ sectionPlane: { ...section, enabled: true } });
  try {
    const ui = render(<AppearanceScanPanel />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.match(ui.textContent!, /Turn off section, terrain and box clipping/);
    assert.equal(ui.querySelector('canvas'), null);
  } finally { useViewerStore.setState({ sectionPlane: section }); }
});

test('alignment offers a loaded IFC without requiring a prior selection to create its mutation view (#4381)', async () => {
  await alignmentFixture();
  useViewerStore.setState({ mutationViews: new Map() });
  const ui = render(<AppearanceScanPanel />);
  const target = ui.querySelectorAll('select')[1];
  assert.equal(target.options.length, 2);
  assert.equal(target.value, 'target');
  assert.ok(useViewerStore.getState().getMutationView('target'), 'preparation uses the shared canonical view factory');
});

import { StoreEditor } from '@ifc-lite/mutations';
import { scanTargetGlobalId } from '@/lib/appearance/scan/landmarks';
test('scan target identities include overlay-created IFC owners and refuse a cleared effective GUID (#4381)', async () => {
  const { target } = await alignmentFixture();
  const view = useViewerStore.getState().mutationViews.get('target')!;
  const editor = new StoreEditor(target.ifcDataStore!, view);
  const owner = editor.addEntity('IfcBuildingElementProxy', ['0NewOwner00000000000001', null, 'Captured object', null, null, null, null, null, '.NOTDEFINED.']);
  assert.equal(scanTargetGlobalId(owner.expressId), '0NewOwner00000000000001');
  editor.setPositionalAttribute(owner.expressId, 0, '0Changed000000000000001');
  assert.equal(scanTargetGlobalId(owner.expressId), '0Changed000000000000001');
  editor.setPositionalAttribute(10, 0, null);
  assert.throws(() => scanTargetGlobalId(10), /stable GlobalId/, 'base GUID must not mask an effective null');
});

test('retained alignment rebind accepts UV corner duplication but rejects changed or untracked geometry #4381', async () => {
  const { source, target, mesh } = await alignmentFixture();
  const paired: MeshData = { ...mesh, expressId: 10, geometryItemId: 20, textureRef: undefined };
  const untouched: MeshData = { ...paired, geometryItemId: 21 };
  const geometry = { ...source.geometryResult!, meshes: [paired, untouched] };
  const currentTarget = { ...target, geometryResult: geometry };
  useViewerStore.setState({ models: new Map([['source', source], ['target', currentTarget]]) });
  const session = await prepareScanSession('source', 0, 'target', new AbortController().signal);
  session.retainTargetMesh(paired);
  const rebind = session.afterAppearance();
  const remapped: MeshData = { ...paired, positions: new Float32Array([0,1,0,0,0,0,1,0,0]), indices: new Uint32Array([1,2,0]), uvs: new Float32Array([1,1,0,0,1,0]) };
  const view = useViewerStore.getState().mutationViews.get('target')!;
  new StoreEditor(target.ifcDataStore!, view).setPositionalAttribute(10, 2, 'Updated appearance metadata');
  const nextTarget = { ...currentTarget, geometryResult: { ...geometry, meshes: [remapped, untouched] } };
  useViewerStore.setState({ models: new Map([['source', source], ['target', nextTarget]]), mutationVersion: 1 });
  const next = await prepareScanSession('source', 0, 'target', new AbortController().signal);
  assert.notEqual(next.targetFrame.assetSha256, session.targetFrame.assetSha256, 'new effective IFC bytes require a new native registration request');
  assert.doesNotThrow(() => rebind(next));
  const replace = async (meshes: MeshData[]) => {
    useViewerStore.setState({ models: new Map([['source', source], ['target', { ...nextTarget, geometryResult: { ...geometry, meshes } }]]) });
    return prepareScanSession('source', 0, 'target', new AbortController().signal);
  };
  const moved = { ...remapped, positions: remapped.positions.slice() }; moved.positions[0] += 0.1;
  const changed = await replace([moved, untouched]);
  assert.throws(() => rebind(changed), /paired IFC surface changed/);
  const unrelated = await replace([remapped, { ...untouched }]);
  assert.throws(() => rebind(unrelated), /Unrelated IFC geometry changed/);
});
