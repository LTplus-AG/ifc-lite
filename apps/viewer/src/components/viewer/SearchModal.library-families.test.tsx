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
import { cleanup, render, waitFor } from '@/test/render';
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
import { NativeLibrarySearch } from './libraries/NativeLibrarySearch';
import { useValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { createDocumentSlice } from '@/store/slices/documentSlice';
import { registerLocale, setLocale } from '@/i18n';
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
