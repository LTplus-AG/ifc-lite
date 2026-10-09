/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { IfcParser, effectiveMetadataRecord, extractProjectUnits } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { parseNewIfcProposal, prepareNewIfcFile } from './new-ifc-file';
const state = useViewerStore.getState();
afterEach(() => useViewerStore.setState(state, true));
const supplied = () => parseNewIfcProposal(JSON.stringify({ version: 1, kind: 'ifc.create', title: 'Supplied new project', filename: '../Shared project.ifc', project: { Name: 'Supplied project', Schema: 'IFC4X3', LengthUnit: 'MILLIMETRE', Author: 'Supplied author' }, storeys: [{ Name: 'Supplied level', Elevation: 3000 }] }));
test('#7326 native preparation preserves current 1/N sources/history and publishes complete declared defaults/units/graph', async () => {
  useViewerStore.setState({ models: new Map([['a', fixtureModel('a')], ['b', fixtureModel('b')]]) });
  const before = useViewerStore.getState(), review = await prepareNewIfcFile(supplied());
  assert.equal(useViewerStore.getState().models, before.models); assert.equal(useViewerStore.getState().undoStacks, before.undoStacks); assert.equal(useViewerStore.getState().mutationViews, before.mutationViews);
  assert.equal(review.filename, 'Shared project.ifc'); assert.equal(review.lengthUnitScale, 0.001);
  assert.deepEqual(review.roots.filter(row => ['IfcSite', 'IfcBuilding'].includes(row.type)).map(row => row.Name), ['Site', 'Building']);
  const parsed = await new IfcParser().parseColumnar(new TextEncoder().encode(review.content).buffer, { disableWorkerScan: true });
  const storey = parsed.entityIndex.byType.get('IFCBUILDINGSTOREY')![0]; assert.equal(effectiveMetadataRecord(parsed, storey)?.attributes[9], 3000);
  const project = parsed.entityIndex.byType.get('IFCPROJECT')![0]; assert.equal(extractProjectUnits(parsed.source, parsed.entityIndex, project).resolvedForUnitType('LENGTHUNIT')?.siScale, 0.001);
  assert.equal(parsed.entityIndex.byType.get('IFCMONETARYUNIT')?.length ?? 0, 0); assert.equal(parsed.entityIndex.byType.get('IFCWALL')?.length ?? 0, 0);
});
test('#7326 missing/unsupported native schema, units, elevations and arbitrary creator code refuse', () => {
  for (const change of [{ project: { ...supplied().project, LengthUnit: 'FOOT' } }, { project: { ...supplied().project, Schema: 'IFC2X3' } }, { project: { Name: 'Missing supplied units', Schema: 'IFC4' } }, { storeys: [{ Name: 'Missing supplied elevation' }] }, { project: { ...supplied().project, GuidSource: 'generated code' } }, { code: 'bim.create.project()' }, { storeys: Array.from({ length: 21 }, () => ({ Name: 'too many', Elevation: 0 })) }]) assert.throws(() => parseNewIfcProposal(JSON.stringify({ ...supplied(), ...change })));
});
test('#7326 canonical primary request is one-shot and refuses busy, dirty, shared or superseded workspace', async () => {
  useViewerStore.setState({ models: new Map(), loading: false, dirtyModels: new Set(), collabRoomId: null }); const review = await prepareNewIfcFile(supplied());
  let requests = 0; const listener = (event: Event) => { requests++; assert.ok((event as CustomEvent<File>).detail instanceof File); };
  window.addEventListener('ifc-lite:load-file', listener);
  try {
    useViewerStore.setState({ loading: true }); assert.throws(() => review.requestPrimaryLoad(), /native load/);
    useViewerStore.setState({ loading: false, dirtyModels: new Set(['a']) }); assert.throws(() => review.requestPrimaryLoad(), /Save or leave/);
    useViewerStore.setState({ dirtyModels: new Set(), collabRoomId: 'shared-room' }); assert.throws(() => review.requestPrimaryLoad(), /Save or leave/);
    useViewerStore.setState({ collabRoomId: null, models: new Map([['newer-model', fixtureModel('newer-model')]]) }); assert.throws(() => review.requestPrimaryLoad(), /workspace changed/); assert.equal(requests, 0);
    useViewerStore.setState({ models: new Map() }); review.requestPrimaryLoad(); assert.equal(requests, 1); assert.throws(() => review.requestPrimaryLoad(), /already requested/); assert.equal(useViewerStore.getState().models.size, 0, 'a dispatched request is not an acknowledged loader result');
  } finally { window.removeEventListener('ifc-lite:load-file', listener); }
});
test('#7326 missing browser download capability refuses rather than claiming publication', async () => {
  const review = await prepareNewIfcFile(supplied()), descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  try { Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined }); assert.throws(() => review.download(), /download.*unavailable|browser/i); }
  finally { if (descriptor) Object.defineProperty(globalThis, 'document', descriptor); }
});
