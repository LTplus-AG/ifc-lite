/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, mock, test } from 'node:test';
import { act } from 'react';
import { parseIDS, validateIDS } from '@ifc-lite/ids';
import { createBCFProject, createBCFTopic } from '@ifc-lite/bcf';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { ARCH, seedArtifactModels } from '@/test/artifact-models-fixture';
import { cleanup, render, waitFor, click, type } from '@/test/render';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { blankDocument } from '@/lib/document/presets';
import { validationReportSnapshot, newSavedReport } from '@/lib/validation/reports/history';
import { previewArtifact } from '@/lib/assistant/artifacts/artifact-preview';
import { parseArtifactProposal } from '@/lib/assistant/artifacts/proposal-kinds';
import { saveArtifact } from '@/lib/assistant/artifacts/artifact-save';
import { nativeLibraryCatalogue, searchNativeLibraries, LIBRARY_FAMILIES } from '@/lib/libraries/native-catalogue';
import { openNativeLibraryArtifact } from '@/lib/libraries/open-native-artifact';
import { useLibraryFocus } from '@/lib/libraries/library-focus';
import { SavedValidationReports } from './validation/SavedValidationReports';
import { ClashSavedReportsDialogContent } from './ClashSavedReportsDialogContent';
import { createValidationReportsSlice } from '@/store/slices/validationReportsSlice';
import { createSavedClashReportsSlice } from '@/store/slices/savedClashReportsSlice';
import { NativeLibrarySearch } from './libraries/NativeLibrarySearch';
import { useValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { prepareComparison, comparePreparedPair } from '@/lib/compare/run-comparison';
import { snapshotComparison } from '@/lib/compare/savedComparisons';
import { SavedComparisonLibrary } from './compare/SavedComparisonLibrary';
import { mountClashPanel, detectCoincidentWalls, saveCurrentResultAs } from '@/test/clash-report-fixture';
import { parseFlowDocument, validateFlowWiring } from '@ifc-lite/flow';
import { createStandardRegistry } from '@ifc-lite/flow-nodes';
import { aiNodes } from '@ifc-lite/flow-nodes/ai';
import { flowExamples } from '@/lib/flow/examples';
import { flowToJson, loadSavedFlows } from '@/lib/flow/persistence';
import { createDocumentSlice } from '@/store/slices/documentSlice';
import { registerLocale, setLocale } from '@/i18n';
import { FlavorDialog } from '../extensions/FlavorDialog';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); mock.restoreAll(); setLocale('en'); localStorage.clear(); useLibraryFocus.setState({ target: null }); useViewerStore.setState(initial, true); });
async function finishNativeHydration() {
  await act(async () => {
    const state = useViewerStore.getState();
    await Promise.allSettled([state.initializeDocuments(), state.initializeValidationReports(),
      state.initializeSavedComparisons(), state.initializeSavedClashReports()]);
  });
}
const xml = readFileSync(new URL('../../../../../packages/ids/src/__corpus__/ifctester-parity-6117/empty-required.ids', import.meta.url), 'utf8');

async function nativeLibraries() {
  await seedArtifactModels();
  const state = useViewerStore.getState();
  const model = state.models.get(ARCH);
  assert.ok(model?.ifcDataStore);
  const ids = parseIDS(xml);
  const report = await validateIDS(ids, createDataAccessor(model.ifcDataStore, ARCH),
    { modelId: ARCH, schemaVersion: 'IFC4', entityCount: model.ifcDataStore.entityCount }, { includePassingEntities: true });
  assert.equal(report.summary.totalEntitiesChecked, 4, 'real SketchUp walls are validated before library navigation');
  const saved = newSavedReport(validationReportSnapshot(report, state.models, 'native-library-report'), 'Coordination wall report');
  assert.ok(await state.saveValidationReportEntry(saved));
  assert.equal(state.addValidationDefinition({ kind: 'ids', xml, document: ids }), true);
  assert.equal(await state.upsertDocument({ ...blankDocument(), name: 'Coordination site document' }), true);
  state.createScript('Coordination wall script', 'bim.query.all("IfcWall")');
  state.createFlow('Coordination workflow');
  const project = createBCFProject({ name: 'Coordination issues' });
  const topic = createBCFTopic({ title: 'Coordination wall topic', author: 'native@example.test' });
  state.setBcfProject(project); state.addTopic(topic);
  for (const kind of ['list.proposal', 'lens.proposal'] as const) {
    const body = kind === 'list.proposal'
      ? { list: { name: 'Coordination wall list', entityTypes: ['IfcWall'], columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }] } }
      : { lens: { name: 'Coordination wall lens', rules: [{ name: 'Walls', groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall'] }] }], action: 'colorize', color: '#E53935' }] } };
    const proposal = parseArtifactProposal(JSON.stringify({ version: 1, kind, title: 'Coordination', ...body }), kind);
    const reviewed = await previewArtifact(proposal, useViewerStore.getState());
    assert.ok(saveArtifact(reviewed.artifact).ok, `native ${kind} preview/save succeeds on the real model`);
  }
  const host = new ExtensionHostService({ sdk: createBimContext({ transport: {
    send: () => Promise.reject(new Error('library navigation cannot run the SDK')),
    subscribe: () => () => {}, close: () => {},
  } }) });
  const active = await host.flavors.resetToDefaults();
  await host.flavors.put({ ...active, id: 'coordination-profile', name: 'Coordination profile' });
  const profiles = { phase: 'ready' as const, entries: await host.flavors.list(), owner: host };
  return { host, profiles, report: saved, topic };
}

test('#7235 all nine native library families retain exact artifact navigation on a real IFC model', async () => {
  const { host, profiles, report, topic } = await nativeLibraries();
  const groups = nativeLibraryCatalogue(useViewerStore.getState(), profiles);
  assert.deepEqual(groups.map(group => group.family), [...LIBRARY_FAMILIES]);
  assert.ok(groups.every(group => group.rows.length > 0), 'every real native family has its saved entry');
  assert.equal(searchNativeLibraries(groups, 'coordination WALL', 'lists').length, 1, 'AND search and family filter use native names');
  const selected = useViewerStore.getState().selectedEntityIds;
  const hidden = useViewerStore.getState().hiddenEntities;
  const rows = groups.flatMap(group => group.rows).filter(row => row.kind !== 'profile' || row.id === 'coordination-profile');
  for (const row of rows) {
    assert.equal(await openNativeLibraryArtifact(row, host), 'opened', `native ${row.kind} target opens`);
    assert.deepEqual(useLibraryFocus.getState().target, { kind: row.kind, id: row.id });
    const current = useViewerStore.getState();
    if (row.kind === 'check') {
      assert.equal(current.validationDefinitions.active.ids, row.id);
      assert.equal(useValidationSourceChoice.getState().choice, 'ids');
      assert.equal(current.idsDocument?.info.title, parseIDS(xml).info.title);
      assert.equal(current.idsAuditing, false);
      assert.equal(current.idsValidationReport, null, 'opening checks does not run validation');
    }
    if (row.kind === 'document') assert.equal(current.activeDocumentId, row.id);
    if (row.kind === 'topic') assert.equal(current.activeTopicId, topic.guid);
    if (row.kind === 'script') assert.equal(current.activeScriptId, row.id);
    if (row.kind === 'flow') assert.equal(current.flowDoc?.id, row.id);
    if (row.kind === 'list') assert.equal(current.activeListId, row.id);
    if (row.kind === 'lens') assert.deepEqual(current.pendingArtifactEditor, { kind: 'lens', id: row.id });
  }
  assert.equal(useViewerStore.getState().selectedEntityIds, selected);
  assert.equal(useViewerStore.getState().hiddenEntities, hidden);
  assert.equal(useViewerStore.getState().flowRunning, false);
  assert.equal(useViewerStore.getState().scriptExecutionState, 'idle');
  const reportTarget = rows.find(row => row.kind === 'validation-report' && row.id === report.id);
  assert.ok(reportTarget);
  await openNativeLibraryArtifact(reportTarget, host);
  const ui = render(<SavedValidationReports />);
  await finishNativeHydration();
  const picker = ui.querySelector<HTMLSelectElement>('select[aria-label="Select saved validation report"]');
  assert.ok(picker);
  assert.equal(picker.value, report.id, 'the actual immutable native report history opens the requested saved report');
  assert.match(ui.textContent ?? '', /Coordination wall report/);
});

test('#7235 BCF project replacement cannot reuse a topic guid to open a different native issue', async () => {
  const { profiles, topic } = await nativeLibraries();
  const target = nativeLibraryCatalogue(useViewerStore.getState(), profiles).flatMap(group => group.rows)
    .find(row => row.kind === 'topic' && row.id === topic.guid);
  assert.ok(target);
  const replacement = createBCFProject({ name: 'Different project with reused guid' });
  replacement.topics.set(topic.guid, topic);
  act(() => useViewerStore.getState().setBcfProject(replacement));
  assert.equal(await openNativeLibraryArtifact(target, null), 'changed');
  assert.equal(useViewerStore.getState().activeTopicId, null);
  assert.equal(useLibraryFocus.getState().target, null);
});


test('#7235 mounted catalogue waits for native document hydration and translates chrome without translating stored names', async () => {
  const saved = { ...blankDocument(), name: 'Native stored coordination document' };
  assert.equal(await useViewerStore.getState().upsertDocument(saved), true);
  useViewerStore.setState(createDocumentSlice(useViewerStore.setState, useViewerStore.getState, useViewerStore));
  assert.equal(useViewerStore.getState().documentsStorage.phase, 'loading');
  registerLocale('native-library-test', { 'searchModal.library.query': 'Artefakte suchen',
    'searchModal.library.family.documents': 'Dokumente' });
  setLocale('native-library-test');
  const ui = render(<NativeLibrarySearch onOpened={() => { throw new Error('hydration never opens artifacts'); }} />);
  assert.ok(ui.querySelector('input[aria-label="Artefakte suchen"]'));
  assert.match(ui.querySelector('ul[aria-label="Native library availability"]')?.textContent ?? '', /Dokumente/);
  assert.equal([...ui.querySelectorAll('button')].some(button => button.textContent === saved.name), false,
    'native IndexedDB hydration remains pending at initial render');
  await finishNativeHydration();
  await waitFor(() => [...ui.querySelectorAll('button')].some(button => button.textContent === saved.name), 'native saved document hydrated');
  assert.equal(useViewerStore.getState().documentsStorage.phase, 'ready');
  assert.equal(useViewerStore.getState().activeDocumentId, null);
});

test('#7235 actual native document read refusal stays distinct from a confirmed empty library', async () => {
  useViewerStore.setState(createDocumentSlice(useViewerStore.setState, useViewerStore.getState, useViewerStore));
  mock.method(IDBDatabase.prototype, 'transaction', () => { throw new DOMException('native read denied', 'SecurityError'); });
  const ui = render(<NativeLibrarySearch onOpened={() => { throw new Error('unavailable library cannot navigate'); }} />);
  await finishNativeHydration();
  await waitFor(() => useViewerStore.getState().documentsStorage.phase === 'unavailable', 'actual document read refusal');
  assert.match(ui.querySelector('ul[aria-label="Native library availability"]')?.textContent ?? '', /Documents:.*unavailable/i);
  assert.equal(useViewerStore.getState().documents.length, 0);
});


test('#7235 independent native comparison/clash reports complete all eleven catalogue kinds without rerunning', async () => {
  const { host, profiles } = await nativeLibraries();
  await seedArtifactModels({ federated: true });
  const state = useViewerStore.getState();
  const baseModel = state.models.get('arch'), headModel = state.models.get('wall'); assert.ok(baseModel); assert.ok(headModel);
  const prepared = await prepareComparison({ baseModel, headModel, getMutationView: () => null,
    mutationVersion: state.mutationVersion, contentVersion: state.geometryContentVersion });
  const compared = comparePreparedPair(prepared, { scope: 'data', excludedTypes: [], matchByContent: false });
  assert.ok(compared.diff.entries.length > 0, 'actual SketchUp and Bonsai IFC comparison produces a completed native report');
  const comparison = snapshotComparison(compared, state.models, 'Coordination native comparison');
  assert.equal(await state.saveComparison(comparison), true);
  mountClashPanel(); await detectCoincidentWalls(2, 2);
  const clash = await saveCurrentResultAs('Coordination native clash');
  assert.equal(clash.clashes.length, 1, 'actual native two-model coincident walls supply the immutable report');
  const before = useViewerStore.getState();
  const groups = nativeLibraryCatalogue(before, profiles);
  assert.deepEqual(new Set(groups.flatMap(group => group.rows.map(row => row.kind))), new Set([
    'check', 'validation-report', 'comparison-report', 'clash-report', 'topic', 'document', 'flow', 'script', 'list', 'lens', 'profile',
  ]));
  cleanup();
  const ui = render(<NativeLibrarySearch onOpened={() => {}} />);
  await finishNativeHydration();
  type(ui.querySelector('input[aria-label="Search saved artifact names and types"]') as HTMLInputElement, 'Coordination native comparison');
  const open = [...ui.querySelectorAll('button')].find(button => button.textContent === comparison.name); assert.ok(open); click(open);
  await waitFor(() => useLibraryFocus.getState().target?.id === comparison.id, 'mounted catalogue opens exact native comparison');
  cleanup(); const history = render(<SavedComparisonLibrary result={null} running={false} />);
  await waitFor(() => !!history.querySelector(`option[value="${comparison.id}"]`), 'native comparison history loads');
  const picker = history.querySelector<HTMLSelectElement>('select'); assert.ok(picker);
  await waitFor(() => picker.value === comparison.id, 'native comparison picker consumes the exact catalogue owner');
  const clashTarget = groups.flatMap(group => group.rows).find(row => row.kind === 'clash-report' && row.id === clash.id); assert.ok(clashTarget);
  cleanup(); mountClashPanel();
  await act(async () => { assert.equal(await openNativeLibraryArtifact(clashTarget, host), 'opened'); });
  await waitFor(() => !!document.querySelector(`[data-clash-report="${clash.id}"]`), 'native clash report dialog opens exact saved entry');
  const after = useViewerStore.getState();
  assert.equal(after.clashRunSeq, before.clashRunSeq);
  assert.strictEqual(after.clashResult, before.clashResult);
  assert.strictEqual(after.models, before.models);
  assert.deepEqual(after.selectedEntityIds, before.selectedEntityIds);
  assert.deepEqual(after.hiddenEntities, before.hiddenEntities);
  assert.equal(after.flowRunning, false); assert.equal(after.scriptExecutionState, 'idle');
});

test('#7235 portable native Flow examples keep their registered parameters through import, catalogue Open and export without Run', async () => {
  await seedArtifactModels({ federated: true });
  const registry = createStandardRegistry().registerAll(aiNodes);
  const initialModels = useViewerStore.getState().models;
  const examples = flowExamples();
  assert.ok(examples.reduce((count, example) => count + example.inputs.length, 0) > 0, 'the original native examples provide real Player parameter witnesses');
  for (const example of examples) {
    const portable = parseFlowDocument(flowToJson(example));
    assert.deepEqual(validateFlowWiring(portable, registry), []);
    assert.equal(portable.inputs.length, example.inputs.length, 'export retains the ORIGINAL native example input count');
    assert.deepEqual(portable.inputs, example.inputs, 'canonical export preserves original native input names, labels, kinds and optional values');
    for (const input of example.inputs) {
      const node = portable.nodes.find(entry => entry.id === input.nodeId); assert.ok(node);
      const parameter = registry.get(node.type)?.params.find(entry => entry.name === input.param); assert.ok(parameter);
      const original = example.nodes.find(entry => entry.id === input.nodeId); assert.ok(original);
      assert.deepEqual(node.params?.[input.param], original.params?.[input.param], 'native parameter value survives canonical export');
    }
    const state = useViewerStore.getState(); let id: string | null = null;
    act(() => { id = state.importFlow(portable); state.closeFlow(); }); assert.ok(id);
    const saved = loadSavedFlows().find(entry => entry.doc.id === id); assert.ok(saved);
    const ui = render(<NativeLibrarySearch onOpened={() => {}} />);
    await finishNativeHydration();
    type(ui.querySelector('input[aria-label="Search saved artifact names and types"]') as HTMLInputElement, portable.name);
    const button = [...ui.querySelectorAll('button')].find(entry => entry.textContent === portable.name); assert.ok(button); click(button);
    await waitFor(() => useViewerStore.getState().flowDoc?.id === id, 'mounted catalogue opens imported native template');
    const current = useViewerStore.getState(); assert.ok(current.flowDoc);
    assert.deepEqual(current.flowDoc.inputs, example.inputs, 'native library Open retains the original producer parameter bindings');
    assert.deepEqual(parseFlowDocument(flowToJson(current.flowDoc)).inputs, example.inputs, 're-export preserves the original native inputs');
    assert.deepEqual(parseFlowDocument(flowToJson(current.flowDoc)), saved.doc, 'canonical portable document survives the native library and editor boundary');
    assert.equal(current.flowRunning, false); assert.equal(current.flowLastRun, null);
    assert.strictEqual(current.models, initialModels);
    cleanup();
  }
});

for (const kind of ['validation-report', 'clash-report'] as const) test(`#7235 held ${kind} does not claim missing when a fresh native library read is denied`, async () => {
  const { profiles, report: validation } = await nativeLibraries();
  let id = validation.id;
  if (kind === 'clash-report') {
    mountClashPanel(); await detectCoincidentWalls(2, 2);
    const report = await saveCurrentResultAs('Native held unreadable clash');
    assert.equal(report.clashes.length, 1); id = report.id;
  }
  const target = nativeLibraryCatalogue(useViewerStore.getState(), profiles).flatMap(group => group.rows)
    .find(row => row.kind === kind && row.id === id); assert.ok(target);
  assert.equal(await openNativeLibraryArtifact(target, null), 'opened');
  cleanup();
  // Actual startup controllers reset their in-memory projection, not their
  // durable entries or the held native library target.
  const fresh = kind === 'validation-report' ? createValidationReportsSlice : createSavedClashReportsSlice;
  useViewerStore.setState(fresh(useViewerStore.setState, useViewerStore.getState, useViewerStore));
  const denied = mock.method(IDBDatabase.prototype, 'transaction', () => { throw new DOMException('Native saved report read denied', 'SecurityError'); });
  render(kind === 'validation-report' ? <SavedValidationReports /> : <ClashSavedReportsDialogContent open onOpenChange={() => {}} />);
  await act(async () => {
    const state = useViewerStore.getState();
    assert.equal(await (kind === 'validation-report' ? state.initializeValidationReports() : state.initializeSavedClashReports()), false);
  });
  const state = useViewerStore.getState();
  assert.equal((kind === 'validation-report' ? state.validationReportsStorage : state.savedClashReportsStorage).phase, 'unavailable');
  assert.doesNotMatch(document.body.textContent ?? '', /This artifact is no longer available/, 'a genuine native read refusal does not establish deletion');
  assert.equal(await openNativeLibraryArtifact(target, null), 'unavailable', 'held native Open preserves the current source-read distinction');
  denied.mock.restore();
  await act(async () => {
    const current = useViewerStore.getState();
    assert.equal(await (kind === 'validation-report' ? current.initializeValidationReports() : current.initializeSavedClashReports()), true);
  });
  assert.ok((kind === 'validation-report' ? useViewerStore.getState().savedValidationReports : useViewerStore.getState().savedClashReports).some(row => row.id === id), 'the actual durable report survives the refused read');
  assert.doesNotMatch(document.body.textContent ?? '', /This artifact is no longer available/);
  await act(async () => {
    const current = useViewerStore.getState();
    assert.equal(await (kind === 'validation-report' ? current.removeValidationReport(id) : current.deleteSavedClashReport(id)), true);
  });
  assert.match(document.body.textContent ?? '', /This artifact is no longer available/, 'native successful deletion with a ready source genuinely confirms missing');
  const other = kind === 'validation-report' ? createSavedClashReportsSlice : createValidationReportsSlice;
  useViewerStore.setState(other(useViewerStore.setState, useViewerStore.getState, useViewerStore));
  const otherDenied = mock.method(IDBDatabase.prototype, 'transaction', () => { throw new DOMException('Other native report library denied', 'SecurityError'); });
  await act(async () => {
    const current = useViewerStore.getState();
    assert.equal(await (kind === 'validation-report' ? current.initializeSavedClashReports() : current.initializeValidationReports()), false);
  });
  assert.equal(nativeLibraryCatalogue(useViewerStore.getState(), profiles).find(group => group.family === 'reports')?.phase, 'unavailable');
  assert.equal(await openNativeLibraryArtifact(target, null), 'missing', 'another unreadable report source cannot hide proven deletion in this ready native source');
  otherDenied.mock.restore();
});


test('#7235 native profile dialog read must establish absence before claiming a held profile is missing', async () => {
  const { host, profiles } = await nativeLibraries();
  const target = profiles.entries.find(profile => profile.id === 'coordination-profile'); assert.ok(target);
  useLibraryFocus.setState({ target: { kind: 'profile', id: target.id } });
  render(<ExtensionHostContext.Provider value={host}><FlavorDialog open onClose={() => {}} /></ExtensionHostContext.Provider>);
  assert.doesNotMatch(document.body.textContent ?? '', /This artifact is no longer available/, 'a pending real native read cannot establish deletion');
  await waitFor(() => Boolean(document.querySelector('li[aria-current="true"]')), 'actual native profile read finishes');
  assert.match(document.querySelector('li[aria-current="true"]')?.textContent ?? '', /Coordination profile/);
  cleanup();
  const denied = mock.method(IDBDatabase.prototype, 'transaction', () => { throw new DOMException('Native profile read denied', 'SecurityError'); });
  render(<ExtensionHostContext.Provider value={host}><FlavorDialog open onClose={() => {}} /></ExtensionHostContext.Provider>);
  await waitFor(() => /Its native library could not open this artifact/.test(document.body.textContent ?? ''), 'actual denied native profile read remains visible');
  assert.doesNotMatch(document.body.textContent ?? '', /This artifact is no longer available/, 'a refused read cannot establish deletion');
  cleanup(); denied.mock.restore();
  render(<ExtensionHostContext.Provider value={host}><FlavorDialog open onClose={() => {}} /></ExtensionHostContext.Provider>);
  await waitFor(() => Boolean(document.querySelector('li[aria-current="true"]')), 'actual native repair recovers the durable profile');
  await act(async () => { await host.flavors.delete(target.id); });
  await waitFor(() => /This artifact is no longer available/.test(document.body.textContent ?? ''), 'successful native refresh confirms the real deletion');
});

test('#7235 native deletion of library-targeted report keeps the remaining report picker usable', async () => {
  const { report: first } = await nativeLibraries();
  const second = newSavedReport(first.snapshot, 'Other native report');
  assert.ok(await useViewerStore.getState().saveValidationReportEntry(second));
  useLibraryFocus.setState({ target: { kind: 'validation-report', id: first.id } });
  render(<SavedValidationReports />);
  const remove = [...document.querySelectorAll('button')].find(button => button.textContent === 'Remove report'); assert.ok(remove);
  click(remove);
  await waitFor(() => !useViewerStore.getState().savedValidationReports.some(report => report.id === first.id), 'actual native removal commits');
  assert.match(document.body.textContent ?? '', /This artifact is no longer available/, 'the requested deleted report is not silently replaced');
  const picker = document.querySelector<HTMLSelectElement>('select[aria-label="Select saved validation report"]'); assert.ok(picker, 'remaining native reports stay selectable');
  assert.ok([...picker.options].some(option => option.value === second.id));
  act(() => { picker.value = second.id; picker.dispatchEvent(new window.Event('change', { bubbles: true })); });
  assert.equal(useLibraryFocus.getState().target, null);
  assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="Select saved validation report"]')?.value, second.id);
  assert.doesNotMatch(document.body.textContent ?? '', /This artifact is no longer available/);
});
