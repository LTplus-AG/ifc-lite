/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { readFile } from 'node:fs/promises';
import { act } from 'react';
import { IfcParser } from '@ifc-lite/parser';
import { IfcTypeEnum } from '@ifc-lite/data';
import { installLayout } from '@/test/dom-layout';
import { render, cleanup, click, press, type, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore, type FederatedModel } from '@/store';
import type { ListDefinition } from '@/lib/lists';
import { carryListRun, listRunDefinition } from '@/lib/lists/run-provenance';
import { ListPanel } from './ListPanel';
installLayout();
const initial = useViewerStore.getState();
const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;
afterEach(() => { cleanup(); mock.restoreAll(); URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL; useViewerStore.setState(initial, true); });
function definition(name = 'Authored walls'): ListDefinition {
  return { id: name, name, createdAt: 1, updatedAt: 1, entityTypes: [], groups: [],
    columns: [{ id: 'guid', source: 'attribute', propertyName: 'GlobalId', label: 'GlobalId' },
      { id: 'name', source: 'attribute', propertyName: 'Name', label: 'Name' }] };
}
async function setup(def = definition(), scoped = false) {
  const bytes = await readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
  const wall = store.entityIndex.byType.get('IFCWALL')?.[0]; assert.ok(wall, 'authored SketchUp wall');
  const model = { ...fixtureModel('authored', { idOffset: 1_000_000 }), name: 'Captured architecture.ifc', ifcDataStore: store };
  const peer = { ...fixtureModel('peer', { idOffset: 2_000_000 }), name: 'Excluded peer.ifc', ifcDataStore: store };
  const own = { ...def, expressIdsByModel: { authored: [wall], ...(scoped ? { peer: [wall] } : {}) },
    ...(scoped ? { modelTagScope: { op: 'hasAny' as const, tagIds: ['architecture'] } } : {}) };
  useViewerStore.setState({ ...fixtureModels(model, ...(scoped ? [peer] : [])), ifcDataStore: store,
    mutationViews: new Map(), listDefinitions: [own], activeListId: null, listResult: null, listExecuting: false,
    listError: null, pendingListDraft: null, zoneSets: [], modelTags: new Map([['architecture', { id: 'architecture', name: 'Architecture' }]]),
    modelTagAssignments: new Map([['authored', new Set(['architecture'])]]) });
  const ui = render(<ListPanel />);
  const run = async (name = own.name) => {
    const button = ui.querySelector(`button[aria-label="Run list ${name}"]`); assert.ok(button, 'native saved list Run');
    click(button); await waitFor(() => !useViewerStore.getState().listExecuting, 'native list terminal outcome');
    // A parsed IFC has no GPU mesh population in this headless test: use the native all-object table mode.
    const visibleOnly = ui.querySelector('button[aria-label="Showing visible objects only"]');
    if (!useViewerStore.getState().listError && visibleOnly) click(visibleOnly);
  };
  return { ui, run, own, model, peer, wall, guid: store.entities.getGlobalId(wall) };
}
function region(ui: HTMLElement) {
  const view = ui.querySelector('section[aria-label="Authored walls results"]');
  assert.ok(view, '#7166 Lists uses the shared native ResultView region'); return view;
}
it('#7166 real authored list renders captured source, models and native matched coverage', async () => {
  const run = await setup(); await run.run();
  const result = useViewerStore.getState().listResult; assert.ok(result);
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].modelId, 'authored');
  assert.equal(result.rows[0].values[0], run.guid);
  const view = region(run.ui);
  assert.match(view.textContent ?? '', /Captured architecture.ifc/);
  assert.match(view.textContent ?? '', /1 matched/);
  assert.ok(view.textContent?.includes(run.guid ?? 'missing-guid'), 'actual native row is rendered in the table');
  assert.ok(view.querySelector('fieldset[aria-label="Result actions"]'), 'native export belongs to shared action group');
});
it('#7166 native tag-scoped source names only evaluated models and remains captured after model rename', async () => {
  const run = await setup(definition(), true); await run.run();
  const view = region(run.ui);
  assert.match(view.textContent ?? '', /Captured architecture.ifc/); assert.doesNotMatch(view.textContent ?? '', /Excluded peer.ifc/);
  await act(async () => { useViewerStore.setState({ models: new Map([['authored', { ...run.model, name: 'New source label.ifc' }], ['peer', run.peer]]), activeModelId: 'peer' }); });
  assert.match(view.textContent ?? '', /Captured architecture.ifc/); assert.doesNotMatch(view.textContent ?? '', /New source label.ifc/);
  assert.equal(useViewerStore.getState().listResult?.rows[0].modelId, 'authored');
});
it('#7166 native explicit snapshot source excludes available providers with no targeted members', async () => {
  const run = await setup(definition(), true);
  const own = { ...run.own, modelTagScope: undefined, expressIdsByModel: { authored: [run.wall] } };
  await act(async () => { useViewerStore.setState({ listDefinitions: [own] }); });
  await run.run();
  const result = useViewerStore.getState().listResult; assert.ok(result);
  assert.equal(result.totalCount, 1); assert.equal(result.rows[0].modelId, 'authored');
  assert.equal(result.rows[0].values[0], run.guid);
  assert.match(region(run.ui).textContent ?? '', /Captured architecture.ifc/);
  assert.doesNotMatch(region(run.ui).textContent ?? '', /Excluded peer.ifc/);
});
it('#7166 native search hides real matching rows with filtered state and original matched count', async () => {
  const run = await setup(); await run.run();
  const input = run.ui.querySelector<HTMLInputElement>('input[aria-label="Filter list results"]'); assert.ok(input);
  type(input, 'no-authored-row-has-this-name');
  assert.ok(run.ui.querySelector('[data-result-state="filtered"]'), 'shared filtered state');
  assert.equal(useViewerStore.getState().listResult?.rows.length, 1, 'native filter leaves actual matched result intact');
  assert.match(region(run.ui).textContent ?? '', /1 matched/);
  assert.match(region(run.ui).textContent ?? '', /0 visible/);
});
it('#7166 native empty snapshot shows no matching entities without inventing source population coverage', async () => {
  const run = await setup();
  await act(async () => { useViewerStore.setState({ listDefinitions: [{ ...run.own, expressIdsByModel: { authored: [] } }] }); });
  await run.run();
  assert.equal(useViewerStore.getState().listResult?.rows.length, 0);
  assert.ok(run.ui.querySelector('[data-result-state="no-population"]'));
  assert.match(region(run.ui).textContent ?? '', /0 matched/);
});
it('#7166 nonempty authored IFC with no matching doors reports no findings rather than no population', async () => {
  const run = await setup({ ...definition(), entityTypes: [IfcTypeEnum.IfcDoor] });
  assert.equal(run.model.ifcDataStore.entityIndex.byType.get('IFCDOOR')?.length ?? 0, 0, 'authored fixture has walls but no doors');
  // Native snapshots are already evaluated source sets; a live type filter must not retain that snapshot.
  await act(async () => { useViewerStore.setState({ listDefinitions: [{ ...run.own, expressIdsByModel: undefined }] }); });
  await run.run();
  assert.equal(useViewerStore.getState().listResult?.totalCount, 0);
  assert.ok(run.ui.querySelector('[data-result-state="no-findings"]'));
  assert.equal(run.ui.querySelector('[data-result-state="no-population"]'), null);
  assert.match(region(run.ui).textContent ?? '', /Captured architecture.ifc/);
});
it('#7166 actual rejected native rerun retains visible failure and valid recovery source', async () => {
  const run = await setup(); await run.run();
  const back = run.ui.querySelector('button[aria-label="Back to Lists"]'); assert.ok(back); click(back);
  const invalid: ListDefinition = { ...run.own, id: 'rejected', name: 'Rejected pattern', columns: [{ id: 'bad', source: 'property', psetName: 'Pset_WallCommon', propertyName: '/(a+)+$/', label: 'Rejected' }] };
  await act(async () => { useViewerStore.setState({ listDefinitions: [invalid, run.own] }); });
  await run.run(invalid.name);
  assert.match(run.ui.textContent ?? '', /List failed/);
  assert.match(useViewerStore.getState().listError ?? '', /rejected name pattern/);
  assert.equal(run.ui.querySelector('section[aria-label="Rejected pattern results"]'), null, 'native failed rerun is not a successful result');
  await run.run(); assert.ok(region(run.ui));
  assert.equal(useViewerStore.getState().listResult?.rows[0].values[0], run.guid);
});

it('#7166 actual grouped schedule uses filtered state when native search hides all matching members', async () => {
  const grouped = { ...definition(), grouping: { columnId: 'name', columnIds: ['name'], sumColumnIds: [], view: 'schedule' as const } };
  const run = await setup(grouped); await run.run();
  assert.equal(useViewerStore.getState().listResult?.groups?.length, 1, 'actual native grouping');
  const input = run.ui.querySelector<HTMLInputElement>('input[aria-label="Filter list results"]'); assert.ok(input);
  type(input, 'no-schedule-member-matches');
  assert.ok(run.ui.querySelector('[data-result-state="filtered"]'), 'schedule uses same filtered result vocabulary');
  assert.equal(run.ui.querySelectorAll('[data-result-state]').length, 1);
  assert.match(region(run.ui).textContent ?? '', /1 matched/);
});
it('#7166 native targeted loaded model without IFC provider is disclosed as partial coverage', async () => {
  const run = await setup();
  const missing = { ...fixtureModel('peer'), name: 'Missing IFC table data', ifcDataStore: null };
  await act(async () => { useViewerStore.setState({ models: new Map<string, FederatedModel>([['authored', run.model], ['peer', missing]]),
    listDefinitions: [{ ...run.own, expressIdsByModel: { authored: [run.wall], peer: [run.wall] } }] }); });
  await run.run();
  assert.equal(useViewerStore.getState().listResult?.rows.length, 1);
  assert.match(region(run.ui).textContent ?? '', /Partial/);
  assert.match(region(run.ui).textContent ?? '', /No IFC table data was available for Missing IFC table data/);
});
it('#7166 result lacking captured provenance discloses unknown source instead of inferring current picker', async () => {
  const run = await setup(); await run.run();
  const actual = useViewerStore.getState().listResult; assert.ok(actual);
  // Stated invariant: a result without its sidecar provenance cannot acquire source identity from the current picker.
  await act(async () => { useViewerStore.getState().setListResult({ ...actual }); });
  const unknown = run.ui.querySelector('section[aria-label="Unrecorded list source results"]'); assert.ok(unknown);
  assert.match(unknown.textContent ?? '', /not recorded/); assert.match(unknown.textContent ?? '', /Outcome unknown/);
  assert.doesNotMatch(unknown.textContent ?? '', /Captured architecture.ifc/);
  assert.equal(useViewerStore.getState().listResult?.rows[0].values[0], run.guid);
});

it('#7166 actual source-qualified rows remain exported by native CSV actions inside shared result chrome', async () => {
  const run = await setup(); await run.run();
  const blobs: Blob[] = []; const names: string[] = [];
  URL.createObjectURL = blob => { assert.ok(blob instanceof Blob); blobs.push(blob); return 'blob:list-result'; };
  URL.revokeObjectURL = () => {};
  mock.method(HTMLAnchorElement.prototype, 'click', function(this: HTMLAnchorElement) { names.push(this.download); });
  const exportButton = region(run.ui).querySelector('button[aria-label="Export"]'); assert.ok(exportButton);
  press(exportButton, 'ArrowDown');
  await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')].some(item => /CSV/.test(item.textContent ?? '')), 'native export menu');
  const csv = [...document.querySelectorAll('[role="menuitem"]')].find(item => /CSV/.test(item.textContent ?? '')); assert.ok(csv);
  click(csv); await waitFor(() => blobs.length === 1, 'actual native CSV publication');
  assert.ok((await blobs[0].text()).includes(run.guid ?? 'missing-guid'));
  assert.deepEqual(names, ['Authored walls.csv']);
  assert.match(region(run.ui).textContent ?? '', /Captured architecture.ifc/);
});

it('#7166 native column regrouping preserves the executed source and authored members', async () => {
  const run = await setup(); await run.run();
  const original = useViewerStore.getState().listResult; assert.ok(original);
  await act(async () => { useViewerStore.setState({ models: new Map([['authored', { ...run.model, name: 'Later model name.ifc' }]]) }); });
  const options = region(run.ui).querySelector('button[aria-label="Column options"]'); assert.ok(options);
  press(options, 'ArrowDown');
  await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent?.includes('Group by this column')), 'native column grouping menu');
  const group = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.includes('Group by this column')); assert.ok(group);
  click(group);
  await waitFor(() => Boolean(useViewerStore.getState().listResult?.groups?.length), 'native regrouped result');
  const regrouped = useViewerStore.getState().listResult; assert.ok(regrouped);
  assert.notEqual(regrouped, original);
  assert.equal(regrouped.groups?.[0].label, run.guid);
  assert.equal(regrouped.groups?.[0].count, 1);
  assert.equal(regrouped.rows[0].values[0], run.guid);
  assert.match(region(run.ui).textContent ?? '', /Captured architecture.ifc/);
  assert.doesNotMatch(region(run.ui).textContent ?? '', /Later model name.ifc/);
});

it('#7166 selected entities from a removed snapshot model disclose incomplete scope rather than no population', async () => {
  const run = await setup();
  await act(async () => { useViewerStore.setState({ listDefinitions: [{ ...run.own, expressIdsByModel: { removed: [run.wall] } }] }); });
  await run.run();
  assert.equal(useViewerStore.getState().listResult?.totalCount, 0);
  assert.equal(Boolean(run.ui.querySelector('[data-result-state="no-population"]')), false, 'selected source members were unavailable, not absent');
  assert.match(region(run.ui).textContent ?? '', /Partial/);
  assert.match(region(run.ui).textContent ?? '', /unavailable model/);
  assert.equal(Boolean(run.ui.querySelector('[data-result-state="no-findings"]')), false, 'unavailable selected members are not no findings');
  assert.ok(run.ui.querySelector('[data-result-state="partial"]'), 'incomplete evaluation has an honest empty state');
});

it('#7166 native model-tag scope with zero targeted models refuses before any successful result', async () => {
  const run = await setup();
  await act(async () => { useViewerStore.setState({
    modelTags: new Map([['unused', { id: 'unused', name: 'Unused scope' }]]),
    listDefinitions: [{ ...run.own, modelTagScope: { op: 'hasAny', tagIds: ['unused'] } }],
  }); });
  await run.run();
  assert.match(useViewerStore.getState().listError ?? '', /No loaded model matches/);
  assert.equal(useViewerStore.getState().listResult, null);
  assert.equal(run.ui.querySelector('[data-result-state="no-population"]'), null);
  assert.equal(run.ui.querySelector('section[aria-label="Authored walls results"]'), null);
});

it('#7166 unavailable provider outside the native snapshot does not invent a coverage gap', async () => {
  const run = await setup();
  const missing = { ...fixtureModel('peer'), name: 'Not selected provider', ifcDataStore: null };
  await act(async () => { useViewerStore.setState({ models: new Map<string, FederatedModel>([['authored', run.model], ['peer', missing]]) }); });
  await run.run();
  assert.equal(useViewerStore.getState().listResult?.totalCount, 1);
  assert.doesNotMatch(region(run.ui).textContent ?? '', /Partial|Not selected provider/);
  assert.ok(region(run.ui).textContent?.includes(run.guid ?? 'missing-guid'));
});

it('#7166 native model-tag intersection excludes peer snapshot members from the known empty selected population', async () => {
  const run = await setup(definition(), true);
  await act(async () => { useViewerStore.setState({ listDefinitions: [{ ...run.own, expressIdsByModel: { authored: [], peer: [run.wall] } }] }); });
  await run.run();
  assert.equal(useViewerStore.getState().listResult?.totalCount, 0);
  assert.ok(run.ui.querySelector('[data-result-state="no-population"]'));
  assert.doesNotMatch(region(run.ui).textContent ?? '', /Partial|Excluded peer.ifc/);
});

it('#7166 no native data providers disable execution before any result population can be inferred', async () => {
  const run = await setup();
  await act(async () => { useViewerStore.setState({ models: new Map([['authored', { ...run.model, ifcDataStore: null }]]), ifcDataStore: null }); });
  const button = run.ui.querySelector<HTMLButtonElement>('button[aria-label="Run list Authored walls"]'); assert.ok(button);
  assert.equal(button.disabled, true);
  click(button);
  await act(async () => { await Promise.resolve(); });
  assert.equal(useViewerStore.getState().listResult, null);
  assert.equal(Boolean(run.ui.querySelector('[data-result-state="no-population"]')), false);
});

it('#7166 unavailable matched rows remain distinct from live filtering over returned native rows', async () => {
  const run = await setup(definition(), true);
  await act(async () => { useViewerStore.setState({ listDefinitions: [{ ...run.own, expressIdsByModel: undefined, modelTagScope: undefined }] }); });
  await run.run();
  const actual = useViewerStore.getState().listResult; assert.ok(actual);
  const executed = listRunDefinition(actual); assert.ok(executed);
  assert.ok(actual.rows.length > 1, 'real authored IFC supplies more than the capped returned population');
  // Stated ListResult invariant: totalCount precedes pagination; retained rows need not contain every match.
  await act(async () => { useViewerStore.getState().setListResult(carryListRun(actual, { ...actual, rows: actual.rows.slice(0, 1) }, executed)); });
  assert.equal(Boolean(region(run.ui).textContent?.includes('hidden by visibility or search filters')), false, 'unreturned matches were not hidden by a live filter');
  assert.match(region(run.ui).textContent ?? '', /Partial/);
  assert.match(region(run.ui).textContent ?? '', /not available to display/);
  const input = run.ui.querySelector<HTMLInputElement>('input[aria-label="Filter list results"]'); assert.ok(input);
  type(input, 'no-returned-row-can-match-this-name');
  assert.match(region(run.ui).textContent ?? '', /1 matched row is hidden by visibility or search filters/);
  assert.match(region(run.ui).textContent ?? '', /not available to display/);
  await act(async () => { useViewerStore.getState().setListResult(carryListRun(actual, { ...actual, rows: [] }, executed)); });
  assert.ok(run.ui.querySelector('[data-result-state="partial"]'), 'no returned matches disclose partial availability');
  assert.equal(Boolean(run.ui.querySelector('[data-result-state="filtered"]')), false, 'unreturned population is not a filter-empty state');
});

it('#7166 native regrouping of an unrecorded result cannot create executed-source provenance', async () => {
  const run = await setup(); await run.run();
  const actual = useViewerStore.getState().listResult; assert.ok(actual);
  await act(async () => { useViewerStore.getState().setListResult({ ...actual }); });
  const unknown = run.ui.querySelector('section[aria-label="Unrecorded list source results"]'); assert.ok(unknown);
  const options = unknown.querySelector('button[aria-label="Column options"]'); assert.ok(options);
  press(options, 'ArrowDown');
  await waitFor(() => [...document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent?.includes('Group by this column')), 'native column grouping menu');
  const group = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.includes('Group by this column')); assert.ok(group);
  click(group);
  await waitFor(() => Boolean(useViewerStore.getState().listResult?.groups?.length), 'actual native unrecorded rows regroup');
  const regrouped = useViewerStore.getState().listResult; assert.ok(regrouped);
  assert.equal(regrouped.groups?.[0].label, run.guid);
  assert.equal(regrouped.rows[0].values[0], run.guid);
  assert.equal(listRunDefinition(regrouped), null, 'grouping cannot reconstruct what produced these rows');
  const stillUnknown = run.ui.querySelector('section[aria-label="Unrecorded list source results"]'); assert.ok(stillUnknown);
  assert.match(stillUnknown.textContent ?? '', /Outcome unknown/);
  assert.doesNotMatch(stillUnknown.textContent ?? '', /Captured architecture.ifc/);
});
