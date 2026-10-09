/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Campaign6812 audit only: native standalone builder capability, not a new reviewed implementation.
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test, type TestContext } from 'node:test';
import { CreateNamespace } from '@ifc-lite/sdk';
import { fileSchemaIdentifier } from '@ifc-lite/data';
import { IfcParser, effectiveMetadataRecord, extractProjectUnits } from '@ifc-lite/parser';
import { IfcAPI } from '@ifc-lite/wasm';
import { useViewerStore } from '@/store';
import { createModelAdapter } from '@/sdk/adapters/model-adapter';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { danglingReferences } from '@/test/authoring-sample-fixture';
import { ModelChangeProposal } from '@/components/viewer/assistant/ModelChangeProposal';
import { cleanup, render } from '@/test/render';
import { useAssistant } from '@/lib/assistant/conversation';
import { adapterFor } from '@/lib/assistant/adapters/registry';
const assistant = useAssistant.getState(), state = useViewerStore.getState();
afterEach(() => { cleanup(); useAssistant.setState(assistant, true); useViewerStore.setState(state, true); });
function nativeFile(LengthUnit: string, Schema: 'IFC4' | 'IFC4X3' = 'IFC4', wall = false) {
  const creator = new CreateNamespace().project({ Name: 'Supplied project', Description: 'Native standalone capability audit', Schema, LengthUnit, Timestamp: Date.UTC(2026, 0, 2), Author: 'Supplied author', Organization: 'Supplied organization' });
  const storey = creator.addIfcBuildingStorey({ Name: 'Supplied level', Elevation: LengthUnit === 'MILLIMETRE' ? 3000 : 3 });
  const id = wall ? creator.addIfcWall(storey, { Name: 'Supplied wall', Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 }) : null;
  return { ...creator.toIfc(), storey, id };
}
async function graph(LengthUnit: string, Schema: 'IFC4' | 'IFC4X3' = 'IFC4') {
  const file = nativeFile(LengthUnit, Schema), bytes = new TextEncoder().encode(file.content);
  const parsed = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  assert.ok(file.content.startsWith('ISO-10303-21;')); assert.ok(file.content.includes(`FILE_SCHEMA(('${fileSchemaIdentifier(Schema)}'))`));
  assert.ok(file.content.includes("'2026-01-02T00:00:00'")); assert.deepEqual(danglingReferences(file.content), []);
  for (const type of ['IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY']) assert.equal(parsed.entityIndex.byType.get(type)?.length, 1);
  const project = parsed.entityIndex.byType.get('IFCPROJECT')![0], site = parsed.entityIndex.byType.get('IFCSITE')![0], building = parsed.entityIndex.byType.get('IFCBUILDING')![0];
  const rootIds = [project, site, building, file.storey, ...parsed.entityIndex.byType.get('IFCRELAGGREGATES') ?? []];
  const guids = rootIds.map(id => effectiveMetadataRecord(parsed, id)!.attributes[0]); assert.ok(guids.every(guid => typeof guid === 'string' && /^[0-3][0-9A-Za-z_$]{21}$/.test(guid))); assert.equal(new Set(guids).size, rootIds.length, 'actual canonical generated rooted graph owns unique valid IFC GUIDs');
  const refs = [...parsed.entityIndex.byType.get('IFCRELAGGREGATES') ?? []].map(id => effectiveMetadataRecord(parsed, id)!);
  for (const [parent, child] of [[project, site], [site, building], [building, file.storey]]) assert.ok(refs.some(row => row.attributes[4] === parent && (row.attributes[5] as number[]).includes(child)));
  const units = extractProjectUnits(parsed.source, parsed.entityIndex, project).resolvedForUnitType('LENGTHUNIT'); assert.ok(units);
  assert.equal(units.siScale, LengthUnit === 'MILLIMETRE' ? 0.001 : 1);
  assert.equal(effectiveMetadataRecord(parsed, project)?.attributes[2], 'Supplied project');
  assert.equal(effectiveMetadataRecord(parsed, file.storey)?.attributes[2], 'Supplied level');
  assert.equal(parsed.entityIndex.byType.get('IFCMONETARYUNIT')?.length ?? 0, 0, 'no supplied currency means no invented currency');
  return file;
}
for (const [units, schema] of [['METRE', 'IFC4'], ['MILLIMETRE', 'IFC4'], ['METRE', 'IFC4X3']] as const) test(`Campaign6812 new-file native ${schema}/${units} exports canonical rooted scaffold and declared unit graph`, () => graph(units, schema));
test('Campaign6812 native standalone supplied wall reaches real WASM with nonempty finite geometry', async t => {
  if (!ensureWasm(t)) return;
  const file = nativeFile('METRE', 'IFC4', true), bytes = new TextEncoder().encode(file.content), api = new IfcAPI();
  interface PrePass { jobs: Uint32Array; unitScale: number; rtcOffset: number[]; needsShift: boolean; voidKeys: Uint32Array; voidCounts: Uint32Array; voidValues: Uint32Array; styleIds: Uint32Array; styleColors: Uint8Array }
  try {
    const pre: PrePass = api.buildPrePassOnce(bytes);
    const meshes = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, pre.rtcOffset[0], pre.rtcOffset[1], pre.rtcOffset[2], pre.needsShift, pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
    try { assert.ok(meshes.length > 0); let found = false; for (let i = 0; i < meshes.length; i++) { const mesh = meshes.get(i); assert.ok(mesh); try { if (mesh.expressId === file.id) { found = true; assert.ok(mesh.indices.length > 0); assert.ok(mesh.positions.every(Number.isFinite)); } } finally { mesh.free(); } } assert.equal(found, true); }
    finally { meshes.free(); }
  } finally { api.clearPrePassCache(); api.free(); }
});
test('Campaign6812 native SDK load publication emits a real File without claiming loader completion or editing history', async () => {
  const file = await graph('METRE'), before = useViewerStore.getState(); const dispatched: File[] = [];
  const handler = (event: Event) => { dispatched.push((event as CustomEvent<File>).detail); };
  window.addEventListener('ifc-lite:load-file', handler);
  try { createModelAdapter(useViewerStore).loadIfc(file.content, 'supplied-new-file.ifc'); }
  finally { window.removeEventListener('ifc-lite:load-file', handler); }
  assert.equal(dispatched.length, 1); const published = dispatched[0]; assert.ok(published instanceof File); assert.equal(published.name, 'supplied-new-file.ifc'); assert.equal(await published.text(), file.content);
  assert.equal(useViewerStore.getState().models, before.models); assert.equal(useViewerStore.getState().undoStacks, before.undoStacks);
});
test('#7326 blank native context advertises native builder capability without fabricating load facts or script results', () => {
  const empty = { ...useViewerStore.getState(), models: new Map(), scriptExecutionState: 'idle' as const, scriptLastError: null, scriptLastResult: null, scriptLastDiagnostics: [] };
  assert.equal(adapterFor('loadReport').readiness(empty).ready, true); const capture = adapterFor('loadReport').capture(empty, 10); assert.equal(capture.totalRows, 0); assert.deepEqual(capture.rows, []); const summary = capture.summary as { modelCount: number; loadReportsAvailable: boolean; nativeNewIfc: { existingModelFacts: boolean } }; assert.equal(summary.modelCount, 0); assert.equal(summary.loadReportsAvailable, false); assert.equal(summary.nativeNewIfc.existingModelFacts, false); assert.equal(adapterFor('script').readiness(empty).ready, false);
});
test('Campaign6812 actual completed assistant publication lacks a reviewed canonical new-file scaffold route', async () => {
  const native = await graph('METRE'); assert.ok(native.content.includes('IFCPROJECT('));
  useAssistant.setState({ status: 'idle', messages: [{ role: 'assistant', content: JSON.stringify({ version: 1, kind: 'ifc.create', title: 'Supplied native project', filename: 'supplied.ifc', project: { Name: 'Supplied project', Schema: 'IFC4', LengthUnit: 'METRE' }, storeys: [{ Name: 'Supplied level', Elevation: 3 }] }) }] });
  const ui = render(<ModelChangeProposal />);
  assert.ok([...ui.querySelectorAll('button')].some(button => button.textContent === 'Prepare new IFC file'), 'a genuine native scaffold currently has no bounded reviewed publication admission');
});

test('Campaign6812 native new-file audit does not pretend an arbitrary declared length-unit string is supported', async () => {
  const file = nativeFile('FOOT'), bytes = new TextEncoder().encode(file.content);
  const parsed = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  const project = parsed.entityIndex.byType.get('IFCPROJECT')![0];
  assert.equal(extractProjectUnits(parsed.source, parsed.entityIndex, project).resolvedForUnitType('LENGTHUNIT')?.siScale, 1, 'the existing builder currently falls back to a metre declaration; a reviewed route must refuse FOOT rather than assert literal-native parity');
});
