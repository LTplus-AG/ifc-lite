/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { IfcParser, extractClassificationsOnDemand } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { evaluateFilterGroupsFederated } from '@ifc-lite/rules';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { createListDataProvider } from '@/lib/lists/adapter';
import { createLensDataProvider } from '@/lib/lens/adapter';
import { createElementFieldReader } from '@/lib/charts/element-field-reader';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { classificationPopulationUnavailable } from '@/components/viewer/properties/effective-classification-systems';
import { addClassificationAssociation } from './associations';

const pristine = useViewerStore.getState();
afterEach(() => useViewerStore.setState(pristine, true));
async function authoredAssociation() {
  const bytes = new TextEncoder().encode(readFileSync(new URL('../../../public/samples/building-architecture.ifc', import.meta.url), 'utf8'));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: store, maxExpressId: 10000 }), mutationViews: new Map(), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), dirtyModels: new Set(), editEnabled: true, collabRole: null });
  assert.deepEqual(extractClassificationsOnDemand(store, 262), [], 'actual SketchUp wall starts unclassified');
  assert.deepEqual(addClassificationAssociation('m', 262, { system: 'CCI Construction', identification: 'E-AAA-WALL', name: 'Outer wall' }), { ok: true });
  const state = useViewerStore.getState();
  const view = state.mutationViews.get('m')!;
  const out = new StepExporter(store, view).export({ schema: 'IFC4', visibleOnly: false, hiddenEntityIds: new Set<number>() });
  const text = typeof out.content === 'string' ? out.content : new TextDecoder().decode(out.content);
  const data = new TextEncoder().encode(text);
  const reparsed = await new IfcParser().parseColumnar(data.buffer, { disableWorkerScan: true });
  const expected = extractClassificationsOnDemand(reparsed, 262);
  assert.deepEqual(expected.map(row => [row.system, row.identification, row.name]), [['CCI Construction', 'E-AAA-WALL', 'Outer wall']], 'native authoring writes a real IFC association, independently verified by export/reparse');
  return { store, state, view, expected, reparsed };
}

test('#7131 native filter matches the authored classification before export/reload', async () => {
  const { state } = await authoredAssociation();
  const hits = await evaluateFilterGroupsFederated(evaluatorModelsFromState(state), [{ combinator: 'AND', rules: [{ kind: 'classification', system: 'CCI Construction', op: 'isSet', value: '' }] }], { limit: Infinity });
  assert.ok(hits.some(hit => hit.expressId === 262), 'native absence must not conceal an effective association');
});
test('#7131 native list classifications agree with independently reparsed authoring output', async () => {
  const { store, view, expected } = await authoredAssociation();
  assert.deepEqual(createListDataProvider(store, '', undefined, view).getClassifications?.(262), expected.map(row => ({ system: row.system, code: row.identification, name: row.name })));
});
test('#7131 native lens classifications agree with independently reparsed authoring output', async () => {
  const { state, expected } = await authoredAssociation();
  assert.deepEqual(createLensDataProvider(state.models, null, state.mutationViews).getClassifications?.(262), expected);
});
test('#7131 native chart classification discovery and value agree with authored IFC output', async () => {
  const { store, view } = await authoredAssociation();
  const reader = createElementFieldReader(store, view);
  assert.ok(reader.observe([262]).relations.classificationSystems.has('CCI Construction'));
  assert.equal(reader.read(262, { kind: 'classification', system: 'CCI Construction', valueKind: 'category' }), 'E-AAA-WALL');
});

test('#7131 source system Name edits update native memberships and undo returns to the true EXPRESS base value', async () => {
  const { store, view } = await authoredAssociation();
  const state = useViewerStore.getState();
  assert.ok(state.setAttribute('m', 34, 'Name', 'CCI renamed 7131', 'CCI Construction'));
  assert.equal(createListDataProvider(store, '', undefined, view).getClassifications?.(262)[0]?.system, 'CCI renamed 7131');
  const hits = await evaluateFilterGroupsFederated(evaluatorModelsFromState(useViewerStore.getState()), [{ combinator: 'AND', rules: [{ kind: 'classification', system: 'CCI renamed 7131', op: 'isSet', value: '' }] }], { limit: Infinity });
  assert.ok(hits.some(hit => hit.expressId === 262));
  state.undo('m');
  assert.equal(createListDataProvider(store, '', undefined, view).getClassifications?.(262)[0]?.system, 'CCI Construction');
  assert.equal(view.getEffectiveChanges().some(change => change.entityId === 34 && change.name === 'Name'), false, 'restored non-IfcRoot Name is not an effective source edit');
  useViewerStore.getState().redo('m');
  assert.equal(createListDataProvider(store, '', undefined, view).getClassifications?.(262)[0]?.system, 'CCI renamed 7131');
});

test('#7131 named and positional system edits use the native export precedence, regardless of edit order', async () => {
  const { store, view } = await authoredAssociation();
  view.setPositionalAttribute(34, 3, 'CCI positional 7131');
  view.setAttribute(34, 'Name', 'CCI named 7131');
  const out = new StepExporter(store, view).export({ schema: 'IFC4', visibleOnly: false, hiddenEntityIds: new Set<number>() });
  const text = typeof out.content === 'string' ? out.content : new TextDecoder().decode(out.content);
  const reparsed = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
  const expected = extractClassificationsOnDemand(reparsed, 262);
  assert.equal(expected[0]?.system, 'CCI positional 7131');
  assert.deepEqual(createLensDataProvider(useViewerStore.getState().models, null, useViewerStore.getState().mutationViews).getClassifications?.(262), expected);
});

test('#7131 source reference and source recipient edits refresh native classification results', async () => {
  const { reparsed, view: authoredView } = await authoredAssociation();
  const referenceId = [...authoredView.getNewEntitiesOfType('IFCCLASSIFICATIONREFERENCE')][0].expressId;
  const relationId = [...authoredView.getNewEntitiesOfType('IFCRELASSOCIATESCLASSIFICATION')][0].expressId;
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: reparsed, maxExpressId: 20000 }), mutationViews: new Map(), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), dirtyModels: new Set() });
  const view = getOrCreateMutationView(useViewerStore, 'm');
  assert.ok(view);
  const list = createListDataProvider(reparsed, '', undefined, view);
  assert.equal(list.getClassifications?.(262)[0]?.code, 'E-AAA-WALL');
  useViewerStore.getState().setAttribute('m', referenceId, 'Identification', 'E-NEW-7131', 'E-AAA-WALL');
  assert.equal(list.getClassifications?.(262)[0]?.code, 'E-NEW-7131', 'a retained native provider refreshes at the actual overlay revision');
  view.setPositionalAttribute(relationId, 4, ['#52']);
  assert.deepEqual(list.getClassifications?.(262), [], 'the old wall no longer has the source association');
  assert.equal(list.getClassifications?.(52)[0]?.code, 'E-NEW-7131', 'the actual source slab receives it');
  const chart = createElementFieldReader(reparsed, view);
  assert.equal(chart.read(52, { kind: 'classification', system: 'CCI Construction', valueKind: 'category' }), 'E-NEW-7131');
  view.deleteEntity(relationId);
  assert.deepEqual(list.getClassifications?.(52), [], 'deleting the source association removes its effective population');
});

test('#7131 classification inheritance follows the current native IfcRelDefinesByType relationship', async () => {
  const { store, view } = await authoredAssociation();
  assert.deepEqual(addClassificationAssociation('m', 260, { system: 'CCI Construction', identification: 'TYPE-A-7131' }), { ok: true });
  assert.deepEqual(addClassificationAssociation('m', 289, { system: 'CCI Construction', identification: 'TYPE-B-7131' }), { ok: true });
  const provider = createListDataProvider(store, '', undefined, view);
  assert.deepEqual(provider.getClassifications?.(262).map(ref => ref.code), ['E-AAA-WALL', 'TYPE-A-7131']);
  view.setPositionalAttribute(261, 5, '#289');
  assert.deepEqual(provider.getClassifications?.(262).map(ref => ref.code), ['E-AAA-WALL', 'TYPE-B-7131'], 'live source type relationship chooses the effective type classification');
  view.deleteEntity(261);
  assert.deepEqual(provider.getClassifications?.(262).map(ref => ref.code), ['E-AAA-WALL'], 'an occurrence keeps its own association after deleting its defining-type relationship');
});

test('#7131 federated views sharing immutable source keep their classification populations independent', async () => {
  const { store } = await authoredAssociation();
  const first = { ...fixtureModel('a'), ifcDataStore: store, maxExpressId: 10000 };
  const second = { ...fixtureModel('b', { idOffset: 1_000_000 }), ifcDataStore: store, maxExpressId: 10000 };
  useViewerStore.setState({ ...fixtureModels(first, second), mutationViews: new Map(), storeEditors: new Map(), undoStacks: new Map(), redoStacks: new Map(), dirtyModels: new Set() });
  assert.deepEqual(addClassificationAssociation('a', 262, { system: 'CCI Construction', identification: 'MODEL-A-7131' }), { ok: true });
  assert.deepEqual(addClassificationAssociation('b', 262, { system: 'CCI Construction', identification: 'MODEL-B-7131' }), { ok: true });
  const state = useViewerStore.getState();
  const firstView = state.mutationViews.get('a')!;
  const secondView = state.mutationViews.get('b')!;
  assert.equal(createListDataProvider(store, '', undefined, firstView).getClassifications?.(262)[0]?.code, 'MODEL-A-7131');
  assert.equal(createListDataProvider(store, '', undefined, secondView).getClassifications?.(262)[0]?.code, 'MODEL-B-7131');
  const hits = await evaluateFilterGroupsFederated(evaluatorModelsFromState(state), [{ combinator: 'AND', rules: [{ kind: 'classification', system: 'CCI Construction', op: 'eq', value: 'MODEL-B-7131' }] }], { limit: Infinity });
  assert.deepEqual(hits.filter(hit => hit.expressId === 262).map(hit => hit.modelId), ['b']);
  assert.deepEqual(extractClassificationsOnDemand(store, 262), [], 'both live memberships leave their shared source unmodified');
});

test('#7131 source-empty classification reads do not recover missing source through a retained accessor closure', async () => {
  const { store, view } = await authoredAssociation();
  const transport = { ...store, source: new Uint8Array() };
  assert.equal(classificationPopulationUnavailable(store, view), false, 'the actual source-bearing authored membership is available');
  assert.equal(classificationPopulationUnavailable(transport, view), true, 'population callers share an explicit source-empty live-edit limitation');
  const refs = extractClassificationsOnDemand(transport, 262, view);
  assert.equal(refs[0]?.identification, 'E-AAA-WALL', 'the complete authored reference remains readable');
  assert.equal(refs[0]?.system, undefined, 'the reused source system has no readable Name');
  assert.equal(refs[0]?.unresolved, true, 'an unavailable source root is not a resolved absence');
  assert.deepEqual(addClassificationAssociation('m', 52, { system: 'Entirely authored 7131', identification: 'AUTHORED-7131' }), { ok: true });
  assert.deepEqual(extractClassificationsOnDemand(transport, 52, view).map(ref => [ref.system, ref.identification, ref.unresolved]), [['Entirely authored 7131', 'AUTHORED-7131', undefined]], 'a complete authored system/reference/association needs no source bytes');
});

test('#7131 a live reference cycle agrees with exported IFC and cannot establish explicit system absence', async () => {
  const { store, view } = await authoredAssociation();
  const reference = [...view.getNewEntitiesOfType('IFCCLASSIFICATIONREFERENCE')][0];
  view.setPositionalAttribute(reference.expressId, 3, `#${reference.expressId}`);
  const out = new StepExporter(store, view).export({ schema: 'IFC4', visibleOnly: false, hiddenEntityIds: new Set<number>() });
  const text = typeof out.content === 'string' ? out.content : new TextDecoder().decode(out.content);
  const reparsed = await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer, { disableWorkerScan: true });
  const expected = extractClassificationsOnDemand(reparsed, 262);
  assert.equal(expected[0]?.unresolved, true, 'the independently decoded IFC has a broken classification chain');
  assert.deepEqual(extractClassificationsOnDemand(store, 262, view), expected);
  const hits = await evaluateFilterGroupsFederated(evaluatorModelsFromState(useViewerStore.getState()), [{ combinator: 'AND', rules: [{ kind: 'classification', system: 'CCI Construction', op: 'isNotSet', value: '' }] }], { limit: Infinity });
  assert.equal(hits.some(hit => hit.expressId === 262), false, 'unknown live system membership cannot prove native absence');
});
