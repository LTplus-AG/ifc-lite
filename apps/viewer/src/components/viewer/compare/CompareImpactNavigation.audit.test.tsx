/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { setValidationSourceChoice, useValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { federationRegistry } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { render, click, cleanup } from '@/test/render';
import { fixtureModels } from '@/test/store-fixture';
import { revisionPair, runClash, PINS } from '@/lib/compare/revision-pair.test-support';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { selectChangedEntity } from '@/lib/changes/select-changed-entity';
import { prepareComparison, comparePreparedPair } from '@/lib/compare/run-comparison';
import type { RevisionPair } from '@/lib/compare/revision-pair.test-support';
import { CompareAnalysisSections } from './CompareAnalysisSections';
const initial = useViewerStore.getState();
async function publishComparison(pair: RevisionPair) {
 const state = useViewerStore.getState();
 const built = await prepareComparison({ baseModel: pair.base, headModel: pair.head,
  getMutationView: state.getMutationView, mutationVersion: state.mutationVersion, contentVersion: state.geometryContentVersion });
 const comparison = comparePreparedPair(built, { scope: 'both', excludedTypes: [], matchByContent: false });
 act(() => useViewerStore.setState({ compareResult: comparison })); return comparison;
}
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); federationRegistry.clear(); setValidationSourceChoice(null); });
it('native revision-pair control selects the added duct in its owning head model', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), compareResult: pair.compare });
 const id = pair.head.ifcDataStore.entities.getExpressIdByGlobalId(PINS.clashAdded);
 assert.ok(id > 0, 'real revision fixture contains its pinned added duct');
 assert.equal(selectChangedEntity(pair.head.id, id), true);
 assert.equal(useViewerStore.getState().selectedEntity?.modelId, pair.head.id);
 assert.equal(useViewerStore.getState().selectedEntity?.expressId, id);
 assert.equal(pair.head.ifcDataStore.entities.getGlobalId(id), PINS.clashAdded);
});
it('impact row exposes native navigation for the real changed duct clash', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), compareResult: pair.compare });
 await publishComparison(pair);
 const clash = stampAnalysisReport(await runClash(pair, ['A', 'B']), captureAnalysisStamp());
 act(() => useViewerStore.setState({ clashResult: clash, clashRawResult: clash }));
 const root = render(<CompareAnalysisSections result={pair.compare} />);
 const toggle = [...root.querySelectorAll('button')].find(b => /Impact on other analyses/.test(b.textContent ?? ''));
 assert.ok(toggle); act(() => click(toggle));
 const row = [...root.querySelectorAll('li')].find(li => li.textContent?.includes(PINS.clashAdded));
 assert.ok(row, 'native clash engine joined the pinned added duct to the actual comparison');
 assert.ok(row.querySelector('button, a[href]'), 'the impacted native finding or changed entity has an accessible navigation action');
});

const openImpact = () => {
 const root = render(<CompareAnalysisSections result={useViewerStore.getState().compareResult!} />);
 const toggle = [...root.querySelectorAll('button')].find(b => /Impact on other analyses/.test(b.textContent ?? ''));
 assert.ok(toggle); act(() => click(toggle)); return root;
};
const impactRow = (root: HTMLElement, text: string) => {
 const row = [...root.querySelectorAll('li')].find(li => li.textContent?.includes(text));
 assert.ok(row, `actual impact row ${text}`); return row;
};
const openButton = (row: HTMLElement) => {
 const button = [...row.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Open original');
 assert.ok(button); return button;
};
it('7307 native clash impact opens its exact finding and selects its head-side changed duct', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), compareResult: pair.compare });
 await publishComparison(pair);
 const clash = stampAnalysisReport(await runClash(pair, ['A', 'B']), captureAnalysisStamp(true));
 act(() => useViewerStore.setState({ clashResult: clash, clashRawResult: clash }));
 const root = openImpact();
 const rows = [...root.querySelectorAll('li')].filter(row => row.textContent?.includes(PINS.clashAdded));
 assert.ok(clash.clashes.length >= 2, '#7338 real native run supplies another finding for wrong-target surgery');
 assert.ok(rows.length > 0);
 const row = rows.at(-1)!;
 const matches = clash.clashes.filter(finding => row.textContent?.includes(finding.rule)
  && row.textContent.includes(finding.a.key) && row.textContent.includes(finding.b.key));
 assert.ok(matches.length > 0);
 // The native pair has colliding wall GUIDs across A/B. Identical visible
 // descriptions remain distinct finding IDs; their documented ID order must
 // retain every native finding rather than selecting any member of the run.
 const equivalentRows = rows.filter(candidate => candidate.textContent === row.textContent);
 const ordered = matches.toSorted((a, b) => a.id.localeCompare(b.id));
 assert.equal(equivalentRows.length, ordered.length, '#7338 every native finding with these exact endpoints has its own row');
 const matching = ordered[equivalentRows.indexOf(row)];
 assert.ok(matching);
 act(() => click(openButton(row)));
 assert.equal(useViewerStore.getState().sidebarActivePanel, 'clash');
 assert.equal(useViewerStore.getState().clashSelectedId, matching.id, '#7338 Open original selects the clicked native finding, not another member of its run');
 const chip = [...row.querySelectorAll('button')].find(b => b.textContent?.includes(PINS.clashAdded));
 assert.ok(chip); assert.equal(chip.disabled, false); act(() => click(chip));
 assert.equal(useViewerStore.getState().selectedEntity?.modelId, 'B');
 const selected = useViewerStore.getState().selectedEntity; assert.ok(selected);
 assert.equal(pair.head.ifcDataStore.entities.getGlobalId(selected.expressId), PINS.clashAdded);
 assert.equal(useViewerStore.getState().clashResult, clash, 'navigation does not rerun or replace the native analysis');
});
it('7307 native validation, list aggregate and BCF topic open their actual owners', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 const { runIds } = await import('@/lib/compare/revision-pair.test-support');
 const { executeList } = await import('@ifc-lite/lists');
 const { IfcTypeEnum } = await import('@ifc-lite/data');
 const { createListDataProvider } = await import('@/lib/lists/adapter');
 const { createBCFProject, createBCFTopic, addViewpointToTopic } = await import('@ifc-lite/bcf');
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), compareResult: pair.compare });
 await publishComparison(pair);
 const report = stampAnalysisReport(await runIds(pair, 'A', { edit: xml => xml.replace(/<\/specifications>/,
  '<specification name="Furniture navigation witness" ifcVersion="IFC4"><applicability><entity><name><simpleValue>IFCFURNITURE</simpleValue></name></entity></applicability><requirements><attribute><name><simpleValue>Description</simpleValue></name><value><simpleValue>never-authored-7307</simpleValue></value></attribute></requirements></specification></specifications>') }), captureAnalysisStamp(true));
 const definition = { id: 'impact-walls', name: 'Native wall navigation', createdAt: 0, updatedAt: 0,
  entityTypes: [IfcTypeEnum.IfcWall], groups: [], columns: [{ id: 'name', source: 'attribute' as const, propertyName: 'Name' }] };
 const list = executeList(definition, createListDataProvider(pair.head.ifcDataStore, 'B'), 'B');
 const project = createBCFProject({ name: 'Actual impact topic' });
 const topic = createBCFTopic({ title: 'Deleted chair native topic', author: 'coordinator@example.com' });
 addViewpointToTopic(topic, { guid: 'impact-native-view', components: { selection: [{ ifcGuid: PINS.deleted }] } });
 project.topics.set(topic.guid, topic);
 act(() => useViewerStore.setState({ idsValidationReport: report, listResult: list, listDefinitions: [definition], activeListId: definition.id, bcfProject: project }));
 setValidationSourceChoice('manual');
 const root = openImpact();
 act(() => click(openButton(impactRow(root, 'Furniture navigation witness'))));
 assert.equal(useValidationSourceChoice.getState().choice, 'ids', 'native validation owner switches from Manual to actual IDS evidence');
 assert.equal(useViewerStore.getState().sidebarActivePanel, 'validation');
 const failed = report.specificationResults.find(s => s.specification.name === 'Furniture navigation witness'); assert.ok(failed);
 assert.equal(useViewerStore.getState().idsActiveSpecificationId, failed.specification.id);
 const ref = useViewerStore.getState().idsActiveEntityId; assert.ok(ref);
 assert.equal(ref.modelId, 'A'); assert.equal(pair.base.ifcDataStore.entities.getGlobalId(ref.expressId), PINS.deleted);
 act(() => click(openButton(impactRow(root, 'Native wall navigation'))));
 assert.equal(useViewerStore.getState().listPanelVisible, true);
 assert.equal(useViewerStore.getState().activeListId, definition.id); assert.equal(useViewerStore.getState().listResult, list);
 assert.match(root.textContent ?? '', /not known to be current/, 'opening aggregate does not invent a freshness stamp');
 act(() => click(openButton(impactRow(root, topic.title))));
 assert.equal(useViewerStore.getState().sidebarActivePanel, 'bcf'); assert.equal(useViewerStore.getState().activeTopicId, topic.guid);
 assert.equal(useViewerStore.getState().selectedEntity?.modelId, 'A', 'BCF topic navigation does not guess a component model');
});
it('7307 held impact actions refuse native source replacement and model edits before React updates', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), compareResult: pair.compare });
 await publishComparison(pair);
 const clash = stampAnalysisReport(await runClash(pair, ['A', 'B']), captureAnalysisStamp(true));
 act(() => useViewerStore.setState({ clashResult: clash, clashRawResult: clash }));
 let root = openImpact(); let row = impactRow(root, PINS.clashAdded); const held = openButton(row);
 act(() => { useViewerStore.setState({ clashResult: null, clashRawResult: null }); click(held); });
 assert.equal(useViewerStore.getState().clashSelectedId, null); assert.notEqual(useViewerStore.getState().sidebarActivePanel, 'clash');
 cleanup(); act(() => useViewerStore.setState({ clashResult: clash, clashRawResult: clash }));
 root = openImpact(); row = impactRow(root, PINS.clashAdded);
 const select = [...row.querySelectorAll('button')].find(b => b.textContent?.includes(PINS.clashAdded)); assert.ok(select);
 act(() => { useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }); click(select); });
 assert.equal(useViewerStore.getState().selectedEntity, null, 'held callback cannot select pre-edit evidence');
 assert.match(root.textContent ?? '', /run before later edits/);
 assert.equal(openButton(impactRow(root, PINS.clashAdded)).disabled, true);
});
it('7307 source-table replacement refuses held and remounted impact navigation, benign wrapper publish remains usable', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 const { IfcParser } = await import('@ifc-lite/parser');
 const { readFileSync } = await import('node:fs');
 const bytes = readFileSync(new URL('../../../../public/samples/building-architecture-rev-b.ifc', import.meta.url));
 const replacement = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
 assert.notEqual(replacement.entities, pair.head.ifcDataStore.entities);
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), compareResult: pair.compare });
 await publishComparison(pair);
 const clash = stampAnalysisReport(await runClash(pair, ['A', 'B']), captureAnalysisStamp(true));
 act(() => useViewerStore.setState({ clashResult: clash, clashRawResult: clash }));
 let root = openImpact(); let row = impactRow(root, PINS.clashAdded);
 // Native spatial-index publications clone a wrapper without reassigning ids.
 act(() => useViewerStore.setState({ models: new Map(useViewerStore.getState().models).set('B',
  { ...pair.head, ifcDataStore: { ...pair.head.ifcDataStore } }) }));
 assert.equal(openButton(impactRow(root, PINS.clashAdded)).disabled, false);
 row = impactRow(root, PINS.clashAdded); const held = openButton(row);
 act(() => { useViewerStore.setState({ models: new Map(useViewerStore.getState().models).set('B',
  { ...pair.head, ifcDataStore: replacement }) }); click(held); });
 assert.equal(useViewerStore.getState().clashSelectedId, null);
 assert.equal(openButton(impactRow(root, PINS.clashAdded)).disabled, true);
 cleanup(); root = openImpact();
 assert.equal(openButton(impactRow(root, PINS.clashAdded)).disabled, true, 'remount cannot bless old comparison sources');
});
it('7307 native current GUID edit/deletion and removed model cannot revive an old impact target', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 const { MutablePropertyView } = await import('@ifc-lite/mutations');
 for (const edit of ['guid', 'delete', 'remove'] as const) {
  cleanup(); useViewerStore.setState(initial, true);
  // Separate real native comparison objects have separate invocation ownership.
  const comparison = { ...pair.compare };
  useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), compareResult: comparison });
  await publishComparison(pair);
 const clash = stampAnalysisReport(await runClash(pair, ['A', 'B']), captureAnalysisStamp(true));
  act(() => useViewerStore.setState({ clashResult: clash, clashRawResult: clash }));
  const root = openImpact(); const row = impactRow(root, PINS.clashAdded);
  const chip = [...row.querySelectorAll('button')].find(b => b.textContent?.includes(PINS.clashAdded)); assert.ok(chip);
  const id = pair.head.ifcDataStore.entities.getExpressIdByGlobalId(PINS.clashAdded);
  const view = new MutablePropertyView(pair.head.ifcDataStore.properties, pair.head.id);
  if (edit === 'guid') view.setAttribute(id, 'GlobalId', '0current7307guidNativeX', PINS.clashAdded);
  if (edit === 'delete') view.deleteEntity(id);
  act(() => {
   if (edit === 'remove') useViewerStore.getState().removeModel('B');
   else useViewerStore.setState({ mutationViews: new Map([['B', view]]) });
   click(chip);
  });
  assert.equal(useViewerStore.getState().selectedEntity, null, `${edit}: no old GUID/express-id navigation`);
 }
});
it('7307 unknown native run freshness keeps facts but disables clash navigation', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), compareResult: { ...pair.compare } });
 await publishComparison(pair);
 const clash = await runClash(pair, ['A', 'B']);
 act(() => useViewerStore.setState({ clashResult: clash, clashRawResult: clash }));
 const root = openImpact(); const row = impactRow(root, PINS.clashAdded);
 assert.match(root.textContent ?? '', /not known to be current/);
 assert.equal(openButton(row).disabled, true);
 assert.ok([...row.querySelectorAll('button')].every(button => button.disabled));
});
it('7307 a replacement before first Impact mount cannot acquire the old native producer lease', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 const { IfcParser } = await import('@ifc-lite/parser');
 const { readFileSync } = await import('node:fs');
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head) });
 await publishComparison(pair);
 const clash = stampAnalysisReport(await runClash(pair, ['A', 'B']), captureAnalysisStamp(true));
 const bytes = readFileSync(new URL('../../../../public/samples/building-architecture-rev-b.ifc', import.meta.url));
 const store = await new IfcParser().parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
 act(() => useViewerStore.setState({ clashResult: clash, clashRawResult: clash,
  models: new Map(useViewerStore.getState().models).set('B', { ...pair.head, ifcDataStore: store }) }));
 const row = impactRow(openImpact(), PINS.clashAdded);
 assert.ok([...row.querySelectorAll('button')].every(button => button.disabled), 'mount never establishes authentic comparison ownership');
});
it('7307 imported/manual comparison without native producer ownership keeps readable facts but no actions', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), compareResult: pair.compare });
 const clash = stampAnalysisReport(await runClash(pair, ['A', 'B']), captureAnalysisStamp(true));
 act(() => useViewerStore.setState({ clashResult: clash, clashRawResult: clash }));
 const row = impactRow(openImpact(), PINS.clashAdded);
 assert.ok([...row.querySelectorAll('button')].every(button => button.disabled));
});
it('7307 direct native overlay revision changes invalidate held and remounted actions without a store counter', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 const { MutablePropertyView } = await import('@ifc-lite/mutations');
 const { configureMutationView } = await import('@/utils/configureMutationView');
 const view = new MutablePropertyView(pair.head.ifcDataStore.properties ?? null, 'B');
 configureMutationView(view, pair.head.ifcDataStore);
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), mutationViews: new Map([['B', view]]) });
 const counter = useViewerStore.getState().mutationVersion;
 await publishComparison(pair);
 const clash = stampAnalysisReport(await runClash(pair, ['A', 'B']), captureAnalysisStamp(true));
 act(() => useViewerStore.setState({ clashResult: clash, clashRawResult: clash }));
 let root = openImpact(); const row = impactRow(root, PINS.clashAdded); const held = openButton(row);
 const revision = view.getMutationRevision();
 const id = pair.head.ifcDataStore.entities.getExpressIdByGlobalId(PINS.clashAdded);
 view.setAttribute(id, 'Name', 'Native edited duct 7307', pair.head.ifcDataStore.entities.getName(id));
 assert.ok(view.getMutationRevision() > revision); assert.equal(useViewerStore.getState().mutationVersion, counter);
 act(() => click(held)); assert.equal(useViewerStore.getState().clashSelectedId, null);
 assert.match(row.querySelector('output')?.textContent ?? '', /no longer identifies current native evidence/);
 cleanup(); root = openImpact(); assert.equal(openButton(impactRow(root, PINS.clashAdded)).disabled, true);
});
it('7307 native preparations cannot bless inputs changed before completion/rediff', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 const { MutablePropertyView } = await import('@ifc-lite/mutations');
 const view = new MutablePropertyView(pair.head.ifcDataStore.properties ?? null, 'B');
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head), mutationViews: new Map([['B', view]]) });
 const state = useViewerStore.getState();
 const built = await prepareComparison({ baseModel: pair.base, headModel: pair.head,
  getMutationView: state.getMutationView, mutationVersion: state.mutationVersion, contentVersion: state.geometryContentVersion });
 const id = pair.head.ifcDataStore.entities.getExpressIdByGlobalId(PINS.clashAdded);
 view.setAttribute(id, 'Name', 'Post-prepare native change', pair.head.ifcDataStore.entities.getName(id));
 const comparison = comparePreparedPair(built, { scope: 'both', excludedTypes: [], matchByContent: false });
 const clash = stampAnalysisReport(await runClash(pair, ['A', 'B']), captureAnalysisStamp(true));
 act(() => useViewerStore.setState({ compareResult: comparison, clashResult: clash, clashRawResult: clash }));
 assert.ok([...impactRow(openImpact(), PINS.clashAdded).querySelectorAll('button')].every(button => button.disabled));
});
it('7307 colliding GUIDs across revisions/another model select only the native requested side', async t => {
 const original = await revisionPair(t); if (!original) return;
 const { createBCFProject, createBCFTopic, addViewpointToTopic } = await import('@ifc-lite/bcf');
 federationRegistry.clear();
 const pair = { ...original, base: { ...original.base, idOffset: useViewerStore.getState().registerModelOffset('A', original.base.maxExpressId) },
  head: { ...original.head, idOffset: useViewerStore.getState().registerModelOffset('B', original.head.maxExpressId) } };
 const other = { ...pair.base, id: 'unrelated-copy', idOffset: useViewerStore.getState().registerModelOffset('unrelated-copy', pair.base.maxExpressId), name: 'Unrelated native source copy' };
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head, other) });
 await publishComparison(pair);
 const project = createBCFProject({ name: 'Ambiguous model-free BCF components' });
 const topic = createBCFTopic({ title: 'Same GUID across real sources', author: 'coordinator@example.com' });
 addViewpointToTopic(topic, { guid: 'native-collision-view', components: { selection: [{ ifcGuid: PINS.dataModified }] } });
 project.topics.set(topic.guid, topic); act(() => useViewerStore.setState({ bcfProject: project }));
 const root = openImpact(); const row = impactRow(root, topic.title);
 const chips = [...row.querySelectorAll('button')].filter(button => button.textContent?.includes(PINS.dataModified));
 assert.equal(chips.length, 2, 'native diff establishes both changed revision sides; BCF supplies no guessed model');
 for (const [side, model] of [['A', pair.base], ['B', pair.head]] as const) {
  const chip = chips.find(button => button.textContent?.trim().startsWith(side + ' ·'));
  assert.ok(chip); assert.equal(chip.disabled, false); act(() => click(chip));
  const selected = useViewerStore.getState().selectedEntity; assert.ok(selected);
  assert.equal(selected.modelId, model.id);
  assert.equal(model.ifcDataStore.entities.getGlobalId(selected.expressId), PINS.dataModified);
  assert.notEqual(selected.modelId, other.id);
 }
 const selected = useViewerStore.getState().selectedEntity;
 act(() => click(openButton(row))); assert.equal(useViewerStore.getState().activeTopicId, topic.guid);
 assert.deepEqual(useViewerStore.getState().selectedEntity, selected, 'opening topic does not resolve its ambiguous component again');
});
it('7307 held native list/BCF/validation links cannot open replacements or deleted originals', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 const { runIds } = await import('@/lib/compare/revision-pair.test-support');
 const { createBCFProject, createBCFTopic, addViewpointToTopic } = await import('@ifc-lite/bcf');
 const { executeList } = await import('@ifc-lite/lists');
 const { IfcTypeEnum } = await import('@ifc-lite/data');
 const { createListDataProvider } = await import('@/lib/lists/adapter');
 for (const kind of ['bcf', 'list', 'validation'] as const) {
  cleanup(); useViewerStore.setState(initial, true); useViewerStore.setState({ ...fixtureModels(pair.base, pair.head) });
  await publishComparison(pair);
  const project = createBCFProject({ name: 'Native source deletion' });
  const topic = createBCFTopic({ title: 'Native topic to delete', author: 'coordinator@example.com' });
  addViewpointToTopic(topic, { guid: 'deleted-native-view', components: { selection: [{ ifcGuid: PINS.deleted }] } });
  project.topics.set(topic.guid, topic);
  const def = { id: 'native-held-list', name: 'Native held list', createdAt: 0, updatedAt: 0,
   entityTypes: [IfcTypeEnum.IfcWall], groups: [], columns: [{ id: 'name', source: 'attribute' as const, propertyName: 'Name' }] };
  const list = executeList(def, createListDataProvider(pair.head.ifcDataStore, 'B'), 'B');
  const report = stampAnalysisReport(await runIds(pair, 'A', { edit: xml => xml.replace(/<\/specifications>/,
   '<specification name="Held validation witness" ifcVersion="IFC4"><applicability><entity><name><simpleValue>IFCFURNITURE</simpleValue></name></entity></applicability><requirements><attribute><name><simpleValue>Description</simpleValue></name><value><simpleValue>never-7307</simpleValue></value></attribute></requirements></specification></specifications>') }), captureAnalysisStamp(true));
  act(() => useViewerStore.setState({ bcfProject: project, idsValidationReport: report,
   activeListId: def.id, listDefinitions: [def], listResult: list }));
  const text = kind === 'bcf' ? topic.title : kind === 'list' ? def.name : 'Held validation witness';
  const root = openImpact(); const held = openButton(impactRow(root, text));
  assert.equal(held.disabled, false);
  act(() => {
   if (kind === 'bcf') useViewerStore.getState().deleteTopic(topic.guid);
   if (kind === 'list') useViewerStore.setState({ activeListId: null, listResult: null });
   if (kind === 'validation') useViewerStore.setState({ idsValidationReport: null });
   click(held);
  });
  assert.notEqual(useViewerStore.getState().sidebarActivePanel, kind === 'bcf' ? 'bcf' : 'validation');
  assert.equal(useViewerStore.getState().listPanelVisible, false);
  assert.equal(useViewerStore.getState().selectedEntity, null);
 }
});
it('7307 actual Information validation evidence opens Rules instead of remembered IDS/Manual side', async t => {
 const pair = await revisionPair(t); if (!pair) return;
 const { runRules } = await import('@/lib/compare/revision-pair.test-support');
 const { Rule } = await import('@ifc-lite/rules');
 useViewerStore.setState({ ...fixtureModels(pair.base, pair.head) }); await publishComparison(pair);
 const report = stampAnalysisReport(await runRules(pair, 'A', { version: 1, name: 'Native information navigation', rules: [{
  id: 'current-wall-name', name: 'Native walls are named',
  applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
  requirement: { kind: 'element', block: { groups: [{ rules: [Rule.attribute('Name', 'eq', 'never-authored-7307')], combinator: 'AND' }], authoredAs: 'chips' } },
 }] }), captureAnalysisStamp(true));
 act(() => useViewerStore.setState({ idsValidationReport: report, validationSource: 'rules' }));
 setValidationSourceChoice('manual'); const root = openImpact();
 const rows = [...root.querySelectorAll('li')].filter(row => row.textContent?.includes('Native walls are named'));
 assert.ok(rows.length >= 2, '#7338 real native rules yield distinct impacted rows; choose a non-first failure');
 const row = rows[1];
 const spec = report.specificationResults.find(result => result.specification.name === 'Native walls are named');
 assert.ok(spec);
 const failures = spec.entityResults.filter(entity => !entity.passed && entity.globalId && row.textContent?.includes(entity.globalId));
 assert.equal(failures.length, 1, '#7338 clicked native changed-entity identity identifies one real failure');
 const expected = failures[0];
 act(() => click(openButton(row)));
 assert.equal(useValidationSourceChoice.getState().choice, 'rules');
 assert.equal(useViewerStore.getState().sidebarActivePanel, 'validation');
 const active = useViewerStore.getState().idsActiveEntityId; assert.ok(active);
 assert.equal(useViewerStore.getState().idsActiveSpecificationId, spec.specification.id);
 assert.deepEqual(active, { modelId: expected.modelId, expressId: expected.expressId }, '#7338 exact clicked failure, not any failed entity from the native report');
 assert.equal(pair.base.ifcDataStore.entities.getGlobalId(active.expressId), expected.globalId);
 assert.equal(useViewerStore.getState().idsValidationReport, report, 'opening exact native failure does not replace the analysis');
});
