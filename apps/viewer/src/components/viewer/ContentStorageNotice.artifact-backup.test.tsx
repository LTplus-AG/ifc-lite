/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import '@/test/download-capture.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { useViewerStore } from '@/store';
import { cleanup, click, render, waitFor } from '@/test/render';
import { seedArtifactModels } from '@/test/artifact-models-fixture';
import { parseArtifactProposal, type ArtifactKind } from '@/lib/assistant/artifacts/proposal-kinds';
import { previewArtifact } from '@/lib/assistant/artifacts/artifact-preview';
import { saveArtifact } from '@/lib/assistant/artifacts/artifact-save';
import { blankDocument } from '@/lib/document/presets';
import { assistantLibrary } from '@/lib/assistant/library';
import { loadSavedFilters, clearSavedFilters, saveFilter } from '@/lib/search/saved-filters';
import { loadListDefinitions, saveListDefinitions } from '@/lib/lists/persistence';
import { ContentStorageNotice } from './ContentStorageNotice';
import { ConfirmDialogHost } from '@/components/ui/confirm-dialog';
import { act } from 'react';
import { ARCH } from '@/test/artifact-models-fixture';
import { placementSourceIdentity } from '@/lib/model-placement/source-identity';
import { evaluatorModelsFromState } from '@/lib/model-tags/evaluator-models';
import { evaluateFilterGroupsFederated } from '@ifc-lite/rules';
import { previewFilterGroups } from '@/lib/assistant/artifacts/artifact-preview';
import { prepareListProviders } from '@/lib/lists/prepare-providers';
import { runListFederated } from '@/lib/lists/run-list';
import { resolveRenderFrame } from '@/hooks/useRenderFrameOffsets';
import { createLensDataProvider } from '@/lib/lens';
import { evaluateLensGroups } from '@/lib/lens/evaluate-lens-groups';
import { evaluateLens } from '@ifc-lite/lens';
import { toGlobalIdFromModels } from '@/store/globalId';
import { createStore } from 'zustand/vanilla';
import { createLensSlice, type LensSlice } from '@/store/slices/lensSlice';
import { createContentBackup, parseContentBackup, type ContentLibraries } from '@/lib/storage/content-backup';

async function nativeBackupWire(libraries: Partial<ContentLibraries>): Promise<string> {
  const state = useViewerStore.getState();
  const previous = { filters: loadSavedFilters(), lists: loadListDefinitions(), lenses: state.exportLenses() };
  const filters = (rows: ReturnType<typeof loadSavedFilters>) => {
    clearSavedFilters();
    for (const row of rows) assert.ok(saveFilter(row.name, row.groups, row.capturedScope).persisted);
  };
  const blobs: Blob[] = [];
  const download = mock.method(URL, 'createObjectURL', (value: Blob | MediaSource) => {
    assert.ok(value instanceof Blob); blobs.push(value); return 'blob:native-source-backup';
  });
  try {
    if (libraries.filters) filters(libraries.filters);
    if (libraries.lists) state.setListDefinitions(libraries.lists);
    if (libraries.lenses) assert.ok(state.setSavedLenses(libraries.lenses).ok);
    const source = { filters: loadSavedFilters(), lists: loadListDefinitions(), lenses: useViewerStore.getState().exportLenses() };
    const ui = render(<Notice />);
    const button = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Download library backup')); assert.ok(button);
    await waitFor(() => !button.disabled, 'native source libraries finish loading before public Download');
    click(button); await waitFor(() => blobs.length === 1, 'native source backup download');
    const wire = await blobs[0].text();
    const decoded = parseContentBackup(wire).libraries;
    for (const kind of ['filters', 'lists', 'lenses'] as const) {
      if (libraries[kind]) assert.equal(decoded[kind]?.length, source[kind].length, `native public Download retains the complete ${kind} source library, including native builtins`);
    }
    return wire;
  } finally {
    download.mock.restore(); cleanup();
    if (libraries.filters) filters(previous.filters);
    if (libraries.lists) state.setListDefinitions(previous.lists);
    if (libraries.lenses) assert.ok(state.setSavedLenses(previous.lenses).ok);
  }
}

async function importNativeLibraries(libraries: Partial<ContentLibraries>): Promise<void> {
  const wire = await nativeBackupWire(libraries);
  const ui = render(<Notice />);
  try {
    const retry = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Retry all libraries')); assert.ok(retry);
    await waitFor(() => !retry.disabled, 'native libraries finish loading before import');
    const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
    Object.defineProperty(input, 'files', { value: [new File([wire], 'native-identity-backup.json')], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => !retry.disabled, 'native import finishes before checking durable results');
    assert.ok(!ui.textContent?.includes('Some saved Filters'), 'the native public import saves every incoming artifact');
  } finally { cleanup(); }
}

const groups = [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall', 'IfcWallStandardCase'] }] }];
const entries: Array<{ kind: ArtifactKind; key: string; body: Record<string, unknown> }> = [
  { kind: 'filter.proposal', key: 'filters', body: { name: 'Backup actual walls', groups } },
  { kind: 'list.proposal', key: 'lists', body: { list: { name: 'Backup actual wall names', entityTypes: ['IfcWall'], groups, columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }] } } },
  { kind: 'lens.proposal', key: 'lenses', body: { lens: { name: 'Backup actual wall colors', rules: [{ name: 'Walls', groups, action: 'colorize', color: '#223344' }] } } },
];
function Notice() {
  const status = useViewerStore(state => state.documentsStorage);
  return <ContentStorageNotice status={status} retry={() => useViewerStore.getState().retryDocumentsSave()}
    restore={() => useViewerStore.getState().restoreDocuments()} />;
}
afterEach(() => { cleanup(); localStorage.clear(); });
beforeEach(() => {
  useViewerStore.setState({ pendingStandaloneArtifactImport: null, contentStorageActionBusy: false });
  clearSavedFilters();
  useViewerStore.getState().setListDefinitions([]); assert.deepEqual(loadListDefinitions(), []);
  assert.ok(useViewerStore.getState().setSavedLenses([]).ok);
});

test('#7218 native empty arrays preserve version-1 while public builtin Lenses stay complete', async () => {
  await seedArtifactModels({ federated: true });
  await Promise.all([assistantLibrary.initialize(), useViewerStore.getState().initializeSavedClashReports()]);
  const blobs: Blob[] = [];
  const download = mock.method(URL, 'createObjectURL', (value: Blob | MediaSource) => {
    assert.ok(value instanceof Blob); blobs.push(value); return 'blob:native-empty-backup';
  });
  const ui = render(<Notice />);
  try {
    const button = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Download library backup')); assert.ok(button);
    await waitFor(() => !button.disabled, 'native empty libraries ready');
    click(button); await waitFor(() => blobs.length === 1, 'native empty Download');
    const wire = await blobs[0].text();
    const decoded = parseContentBackup(wire);
    assert.equal(decoded.version, 2, 'the native public Lens export includes actual builtin Lens definitions');
    assert.equal(decoded.libraries.lenses?.length, useViewerStore.getState().exportLenses().length, 'builtin native definitions are retained rather than silently dropped for compatibility');
    const emptyWire = JSON.stringify(createContentBackup({ validation: [], comparison: [], document: [], filters: [], lists: [], lenses: [] }));
    assert.equal(parseContentBackup(emptyWire).version, 1, 'the stated empty-array invariant requires no new artifact version');
    for (const kind of ['filters', 'lists', 'lenses']) assert.ok(!Object.hasOwn(JSON.parse(emptyWire).libraries, kind));
  } finally { download.mock.restore(); }
});

test('#7218 remounted native notice cannot race a delayed import and clear its refused rows', async () => {
  await seedArtifactModels({ federated: true });
  await Promise.all([assistantLibrary.initialize(), useViewerStore.getState().initializeSavedClashReports()]);
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native delayed import', kind: 'filter.proposal', ...entries[0].body }), 'filter.proposal');
  const saved = await saveArtifact(proposal); assert.ok(saved.ok);
  const wire = await nativeBackupWire({ filters: loadSavedFilters() });
  clearSavedFilters();
  let release: (text: string) => void = () => { throw new Error('file read not started'); };
  let reading = false;
  const file = new File([wire], 'delayed-native-backup.json');
  const delayed = mock.method(file, 'text', () => { reading = true; return new Promise<string>(resolve => { release = resolve; }); });
  let ui = render(<Notice />);
  const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await waitFor(() => reading, 'real File import awaits its text');
  cleanup(); ui = render(<Notice />);
  const legacy = JSON.parse(wire); legacy.version = 1;
  for (const kind of ['filters', 'lists', 'lenses']) delete legacy.libraries[kind];
  const other = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(other);
  const secondFile = new File([JSON.stringify(legacy)], 'legacy-native-backup.json');
  const readSecond = secondFile.text.bind(secondFile); let secondReads = 0;
  const observedSecond = mock.method(secondFile, 'text', () => { secondReads++; return readSecond(); });
  Object.defineProperty(other, 'files', { value: [secondFile], configurable: true });
  await act(async () => { other.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(resolve => setTimeout(resolve, 50)); });
  const original = localStorage.setItem.bind(localStorage);
  const denied = mock.method(localStorage, 'setItem', (key: string, value: string) => {
    if (key === 'ifc-lite:search:saved-filters') throw new DOMException('Native delayed quota', 'QuotaExceededError');
    original(key, value);
  });
  try {
    const button = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Import library backup')); assert.ok(button);
    assert.equal(secondReads, 0, 'a second real File cannot start reading while the first owner remains unfinished');
    assert.ok(button.disabled, 'the same tab import remains owned across remount');
  } finally {
    await act(async () => { release(wire); });
    await waitFor(() => useViewerStore.getState().pendingStandaloneArtifactImport !== null, 'original refused rows remain retryable');
    denied.mock.restore(); delayed.mock.restore(); observedSecond.mock.restore();
  }
});

for (const action of ['download', 'import'] as const) test(`#7218 native ${action} retains a List saved by another tab after this tab loaded`, async () => {
  await seedArtifactModels({ federated: true });
  await Promise.all([assistantLibrary.initialize(), useViewerStore.getState().initializeSavedClashReports()]);
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native stale tab Lists', kind: 'list.proposal', ...entries[1].body }), 'list.proposal');
  const preview = await previewArtifact(proposal, useViewerStore.getState()); assert.ok(preview.matched > 0);
  assert.equal(preview.artifact.kind, 'list.proposal'); if (preview.artifact.kind !== 'list.proposal') assert.fail('native List required');
  const a = { ...preview.artifact.definition, id: 'native-tab-list-a', name: 'Native tab A' };
  const b = { ...preview.artifact.definition, id: 'native-tab-list-b', name: 'Native tab B' };
  const incoming = { ...preview.artifact.definition, id: 'native-tab-import-c', name: 'Native import C' };
  useViewerStore.getState().setListDefinitions([a]);
  const wire = await nativeBackupWire({ lists: [incoming] });
  assert.ok(saveListDefinitions([a, b]), 'another tab uses the existing native durable List writer');
  assert.deepEqual(useViewerStore.getState().listDefinitions.map(row => row.id), [a.id], 'the original tab is genuinely stale');
  const blobs: Blob[] = [];
  const download = mock.method(URL, 'createObjectURL', (value: Blob | MediaSource) => { assert.ok(value instanceof Blob); blobs.push(value); return 'blob:native-stale-tab'; });
  const ui = render(<Notice />);
  try {
    if (action === 'download') {
      const button = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Download library backup')); assert.ok(button);
      await waitFor(() => !button.disabled, 'native export ready'); click(button);
      await waitFor(() => blobs.length === 1, 'native stale-tab Download');
      assert.ok(parseContentBackup(await blobs[0].text()).libraries.lists?.some(row => row.id === b.id), 'native backup includes the independently saved durable peer');
    } else {
      const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
      Object.defineProperty(input, 'files', { value: [new File([wire], 'native-stale-tab-import.json')], configurable: true });
      await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
      await waitFor(() => loadListDefinitions().some(row => row.id === incoming.id), 'native source List saved');
      assert.ok(loadListDefinitions().some(row => row.id === b.id), 'native import must not overwrite another tab’s durable peer');
    }
  } finally { download.mock.restore(); }
});

for (const action of ['download', 'import'] as const) test(`#7218 native ${action} retains a Lens saved by another tab after this tab loaded`, async () => {
  await seedArtifactModels({ federated: true });
  await Promise.all([assistantLibrary.initialize(), useViewerStore.getState().initializeSavedClashReports()]);
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native stale tab Lenses', kind: 'lens.proposal', ...entries[2].body }), 'lens.proposal');
  const preview = await previewArtifact(proposal, useViewerStore.getState()); assert.ok(preview.matched > 0);
  assert.equal(preview.artifact.kind, 'lens.proposal'); if (preview.artifact.kind !== 'lens.proposal') assert.fail('native Lens required');
  const a = { ...preview.artifact.lens, id: 'native-tab-lens-a', name: 'Native tab A' };
  const b = { ...preview.artifact.lens, id: 'native-tab-lens-b', name: 'Native tab B' };
  const incoming = { ...preview.artifact.lens, id: 'native-tab-lens-import-c', name: 'Native import C' };
  assert.ok(useViewerStore.getState().setSavedLenses([a]).ok);
  const wire = await nativeBackupWire({ lenses: [incoming] });
  const peerTab = createStore<LensSlice>()(createLensSlice);
  assert.ok(peerTab.getState().setSavedLenses([a, b]).ok, 'a fresh native Lens store writes the independent peer');
  assert.ok(!useViewerStore.getState().savedLenses.some(row => row.id === b.id), 'the original tab is genuinely stale');
  const blobs: Blob[] = [];
  const download = mock.method(URL, 'createObjectURL', (value: Blob | MediaSource) => { assert.ok(value instanceof Blob); blobs.push(value); return 'blob:native-stale-lens-tab'; });
  const ui = render(<Notice />);
  try {
    if (action === 'download') {
      const button = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Download library backup')); assert.ok(button);
      await waitFor(() => !button.disabled, 'native Lens export ready'); click(button);
      await waitFor(() => blobs.length === 1, 'native stale-tab Lens Download');
      assert.ok(parseContentBackup(await blobs[0].text()).libraries.lenses?.some(row => row.id === b.id), 'native backup includes the independent durable Lens peer');
    } else {
      const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
      Object.defineProperty(input, 'files', { value: [new File([wire], 'native-stale-lens-tab-import.json')], configurable: true });
      await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
      await waitFor(() => createStore<LensSlice>()(createLensSlice).getState().savedLenses.some(row => row.id === incoming.id), 'native source Lens saved durably');
      assert.ok(createStore<LensSlice>()(createLensSlice).getState().savedLenses.some(row => row.id === b.id), 'native import must not overwrite another tab’s durable Lens');
    }
  } finally { download.mock.restore(); }
});

for (const entry of entries.filter(row => row.key === 'lists' || row.key === 'lenses')) {
  for (const peer of ['none', 'source', 'independent'] as const) test(`#7218 native backup preserves two distinct ${entry.key} identities with identical names and criteria${peer === 'source' ? ' beside an unchanged source peer' : peer === 'independent' ? ' beside an independently saved equal local peer' : ''}`, async () => {
    await seedArtifactModels({ federated: true });
    await Promise.all([assistantLibrary.initialize(), useViewerStore.getState().initializeSavedClashReports()]);
    const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native independent artifact identities', kind: entry.kind, ...entry.body }), entry.kind);
    const preview = await previewArtifact(proposal, useViewerStore.getState());
    assert.ok(preview.matched > 0, 'the real IFC native engine proves the artifact population before backup');
    const saved = saveArtifact(preview.artifact); assert.ok(saved.ok);
    const cloneId = crypto.randomUUID();
    if (preview.artifact.kind === 'list.proposal') {
      useViewerStore.getState().addListDefinition({ ...preview.artifact.definition, id: cloneId });
    } else if (preview.artifact.kind === 'lens.proposal') {
      assert.ok(useViewerStore.getState().importLenses([{ ...preview.artifact.lens, id: cloneId }]).ok);
    } else assert.fail('this witness covers the native identity-keyed List and Lens libraries');
    const nativeRows = () => entry.key === 'lists' ? loadListDefinitions() : useViewerStore.getState().exportLenses();
    const originals = nativeRows().filter(row => row.name === saved.saved.name);
    assert.equal(originals.length, 2, 'the actual native library accepts independently saved identical definitions');
    const identities = originals.map(row => row.id).sort();
    assert.equal(new Set(identities).size, 2);
    let nativeLensColors: Map<number, unknown> | null = null;
    if (preview.artifact.kind === 'lens.proposal') {
      const state = useViewerStore.getState();
      const provider = createLensDataProvider(state.models, state.ifcDataStore, state.mutationViews, id => state.resolveGlobalIdFromModels(id));
      const matches = await evaluateLensGroups(preview.artifact.lens, evaluatorModelsFromState(state), state.models, new Set(state.modelTags.keys()));
      nativeLensColors = new Map(evaluateLens(preview.artifact.lens, provider, matches).colorMap);
      assert.ok(nativeLensColors.size > 0, 'actual native coloring includes its canonical unmatched colors as well as the matched walls');
    }
    const ui = render(<Notice />);
    const button = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Download library backup')); assert.ok(button);
    await waitFor(() => !button.disabled, 'native backup libraries finish loading');
    const blobs: Blob[] = [];
    const download = mock.method(URL, 'createObjectURL', (value: Blob | MediaSource) => {
      assert.ok(value instanceof Blob); blobs.push(value); return 'blob:native-distinct-artifact-backup';
    });
    let text: string;
    try { click(button); await waitFor(() => blobs.length === 1, 'actual native backup download'); text = await blobs[0].text(); }
    finally { download.mock.restore(); }
    const parsed = parseContentBackup(text);
    const exported = entry.key === 'lists' ? parsed.libraries.lists : parsed.libraries.lenses;
    assert.equal(exported?.filter(row => identities.includes(row.id)).length, 2, 'native codecs retain both source identities in the actual downloaded file');
    if (entry.key === 'lists') { useViewerStore.getState().setListDefinitions([]); assert.deepEqual(loadListDefinitions(), []); }
    else assert.ok(useViewerStore.getState().setSavedLenses([]).ok);
    if (peer !== 'none') {
      const peerId = peer === 'source' ? cloneId : crypto.randomUUID();
      if (preview.artifact.kind === 'list.proposal') {
        useViewerStore.getState().addListDefinition({ ...preview.artifact.definition, id: peerId });
      } else if (preview.artifact.kind === 'lens.proposal') {
        assert.ok(useViewerStore.getState().importLenses([{ ...preview.artifact.lens, id: peerId }]).ok);
      }
      assert.equal(nativeRows().filter(row => identities.includes(row.id)).length, peer === 'source' ? 1 : 0);
    }
    const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
    Object.defineProperty(input, 'files', { value: [new File([text], 'independent-native-artifact-backup.json')], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => nativeRows().some(row => identities.includes(row.id)), 'native import publishes a durable source identity');
    await waitFor(() => !button.disabled, 'native import completes');
    const restored = nativeRows().filter(row => row.name === saved.saved.name || row.name.startsWith(`${saved.saved.name} (imported`));
    assert.deepEqual(restored.filter(row => identities.includes(row.id)).map(row => row.id).sort(), identities, 'semantic equality must not collapse independently saved native artifact IDs');
    const state = useViewerStore.getState();
    if (preview.artifact.kind === 'list.proposal') {
      const { pairs } = prepareListProviders(state, resolveRenderFrame(state.models, state.geometryResult));
      for (const list of loadListDefinitions().filter(row => identities.includes(row.id))) {
        assert.equal((await runListFederated(list, pairs, state, { evaluatorModels: evaluatorModelsFromState(state) })).rows.length, preview.matched);
      }
    } else {
      const reloaded = createStore<LensSlice>()(createLensSlice);
      const provider = createLensDataProvider(state.models, state.ifcDataStore, state.mutationViews, id => state.resolveGlobalIdFromModels(id));
      const durable = reloaded.getState().savedLenses.filter(row => identities.includes(row.id));
      assert.deepEqual(durable.map(row => row.id).sort(), identities, '#7218 all native Lens source identities must survive durable reload before engine execution');
      for (const lens of durable) {
        const matches = await evaluateLensGroups(lens, evaluatorModelsFromState(state), state.models, new Set(state.modelTags.keys()));
        assert.deepEqual(evaluateLens(lens, provider, matches).colorMap, nativeLensColors, 'restored native coloring preserves the actual full source engine result');
      }
    }
    const current = nativeRows().map(row => ({ id: row.id, name: row.name }));
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => !button.disabled, 'repeated multi-identity native import completes');
    assert.deepEqual(nativeRows().map(row => ({ id: row.id, name: row.name })), current, 'repeated import preserves every independent native copy without duplicates');
  });
}

for (const entry of entries) test(`#7218 native library download includes the saved ${entry.key} library from actual IFC evidence`, async () => {
  await seedArtifactModels({ federated: true });
  await Promise.all([assistantLibrary.initialize(), useViewerStore.getState().initializeSavedClashReports()]);
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native backup evidence', kind: entry.kind, ...entry.body }), entry.kind);
  const preview = await previewArtifact(proposal, useViewerStore.getState());
  assert.ok(preview.matched > 0, 'the real IFC native preview must produce walls before backup');
  const saved = saveArtifact(preview.artifact);
  assert.ok(saved.ok, 'the actual native artifact save must succeed before backup');
  const rows = entry.key === 'filters' ? loadSavedFilters() : entry.key === 'lists' ? loadListDefinitions() : useViewerStore.getState().exportLenses();
  assert.ok(rows.some(row => row.name === saved.saved.name), 'the artifact is in its native persistent library before export');
  const registered = blankDocument();
  await useViewerStore.getState().upsertDocument(registered);
  const ui = render(<Notice />);
  const button = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Download library backup'));
  assert.ok(button);
  await waitFor(() => !button.disabled, 'native libraries finish loading before backup');
  const blobs: Blob[] = [];
  const download = mock.method(URL, 'createObjectURL', (value: Blob | MediaSource) => {
    assert.ok(value instanceof Blob); blobs.push(value); return 'blob:native-library-backup';
  });
  try {
    click(button);
    await waitFor(() => blobs.length === 1, 'native backup downloads one actual Blob');
    const raw: unknown = JSON.parse(await blobs[0].text());
    assert.ok(raw && typeof raw === 'object' && 'libraries' in raw);
    const libraries = raw.libraries as Record<string, unknown>;
    assert.ok(Array.isArray(libraries.document) && libraries.document.some(row => row.id === registered.id), 'existing registered document is an independent actual download control');
    const downloadedLibrary = libraries[entry.key];
    assert.ok(Array.isArray(downloadedLibrary) && downloadedLibrary.length > 0, 'native Download library backup must retain the standalone saved artifact library');
  } finally { download.mock.restore(); }
});

for (const remount of [false, true]) for (const filterCollision of [false, true]) for (const memoryPeer of [false, true]) test(`#7218 native import preserves a refused List save and retries without duplicating the other libraries${memoryPeer ? ' beside a matching unsaved native draft' : ''}${filterCollision ? ' after a conflicting Filter was already saved' : ''}${remount ? ' across notice unmount/remount' : ''}`, async () => {
  await seedArtifactModels({ federated: true });
  await Promise.all([assistantLibrary.initialize(), useViewerStore.getState().initializeSavedClashReports()]);
  for (const entry of entries) {
    const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Quota evidence', kind: entry.kind, ...entry.body }), entry.kind);
    const preview = await previewArtifact(proposal, useViewerStore.getState());
    assert.ok(preview.matched > 0);
    assert.ok(saveArtifact(preview.artifact).ok);
  }
  const sourceFilter = loadSavedFilters()[0]; assert.ok(sourceFilter);
  let completedFilterNames: string[] = [];
  const state = useViewerStore.getState();
  const text = await nativeBackupWire({ filters: loadSavedFilters(), lists: loadListDefinitions(), lenses: state.exportLenses() });
  clearSavedFilters(); state.setListDefinitions([]); assert.deepEqual(loadListDefinitions(), []); assert.ok(state.setSavedLenses([]).ok);
  if (filterCollision) assert.ok(saveFilter(sourceFilter.name, [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcSlab'] }] }]).persisted);
  let ui = render(<Notice />);
  let input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { value: [new File([text], 'quota-library-backup.json')], configurable: true });
  const original = localStorage.setItem.bind(localStorage);
  const denied = mock.method(localStorage, 'setItem', (key: string, value: string) => {
    if (key === 'ifc-lite-lists') throw new DOMException('Native test quota reached', 'QuotaExceededError');
    original(key, value);
  });
  try {
    await act(async () => { assert.ok(input); input.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => [...ui.querySelectorAll('[role="alert"]')].some(node => node.textContent?.includes('Some saved Filters')), 'native partial-save warning remains visible');
    assert.deepEqual(loadListDefinitions(), []);
    assert.deepEqual(useViewerStore.getState().listDefinitions, [], 'a refused durable save cannot enter the visible library');
    assert.equal(loadSavedFilters().length, 1 + Number(filterCollision));
    completedFilterNames = loadSavedFilters().map(row => row.name);
    if (remount) {
      cleanup(); ui = render(<Notice />);
      input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
      const download = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Download library backup')); assert.ok(download);
      const importButton = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Import library backup')); assert.ok(importButton);
      assert.ok(ui.textContent?.includes('Some saved Filters'), 'pending native imports survive notice unmount/remount');
      assert.equal(download.disabled, true, 'remount cannot download an incomplete backup while import remains pending');
      assert.equal(importButton.disabled, true, 'remount cannot replace the unfinished import');
    }

    assert.equal(createStore<LensSlice>()(createLensSlice).getState().savedLenses.filter(row => row.name === 'Backup actual wall colors').length, 1);
    const legacy = JSON.parse(text); legacy.version = 1;
    delete legacy.libraries.filters; delete legacy.libraries.lists; delete legacy.libraries.lenses;
    Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(legacy)], 'legacy-B.json')], configurable: true });
    await act(async () => { assert.ok(input); input.dispatchEvent(new Event('change', { bubbles: true })); });
    const retryReady = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Retry all libraries')); assert.ok(retryReady);
    await waitFor(() => !retryReady.disabled, 'the attempted second import finishes');
    assert.ok(ui.textContent?.includes('Some saved Filters'), '#7218 importing legacy B must not discard the refused artifact from backup A');
    if (memoryPeer) {
      const incoming = parseContentBackup(text).libraries.lists?.[0]; assert.ok(incoming);
      await act(async () => { useViewerStore.getState().addListDefinition(incoming); });
      assert.ok(useViewerStore.getState().listDefinitions.some(row => row.id === incoming.id), 'native List save keeps the actual refused draft in the current session');
      assert.deepEqual(loadListDefinitions(), [], 'the matching native draft has not reached durable storage');
      const retry = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Retry all libraries')); assert.ok(retry);
      await waitFor(() => !retry.disabled, 'the failed import finishes before blocked retry');
      click(retry);
      await waitFor(() => !retry.disabled, 'the blocked retry finishes');
      assert.ok(ui.textContent?.includes('Some saved Filters'), 'a matching in-memory List must not certify the refused backup save');
      assert.deepEqual(loadSavedFilters().map(row => row.name), completedFilterNames, 'Retry of a still-refused library must not re-import a Filter already saved by the same pending operation');
    }
  } finally { denied.mock.restore(); }
  const retry = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Retry all libraries')); assert.ok(retry);
  await waitFor(() => !retry.disabled, 'the failed native import finishes before retry');
  click(retry);
  await waitFor(() => loadListDefinitions().length === 1, 'native Retry all libraries commits the refused List');
  await waitFor(() => !ui.textContent?.includes('Some saved Filters'), 'the pending warning clears only after the retry saves');
  assert.deepEqual(loadSavedFilters().map(row => row.name), completedFilterNames, 'Completing a pending native import must retry only unfinished rows, preserving the already durable conflicting Filter copy');
  assert.equal(createStore<LensSlice>()(createLensSlice).getState().savedLenses.filter(row => row.name === 'Backup actual wall colors').length, 1);
  const { pairs } = prepareListProviders(useViewerStore.getState(), resolveRenderFrame(state.models, state.geometryResult));
  assert.ok((await runListFederated(loadListDefinitions()[0], pairs, useViewerStore.getState(), { evaluatorModels: evaluatorModelsFromState(useViewerStore.getState()) })).rows.length > 0);
});

test('#7218 the native backup parser refuses unknown artifact formats and duplicate identities before any writes', async () => {
  await seedArtifactModels({ federated: true });
  for (const entry of entries) {
    const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Format refusal evidence', kind: entry.kind, ...entry.body }), entry.kind);
    assert.ok(saveArtifact((await previewArtifact(proposal, useViewerStore.getState())).artifact).ok);
  }
  const state = useViewerStore.getState();
  const raw = JSON.parse(await nativeBackupWire({ filters: loadSavedFilters(), lists: loadListDefinitions(), lenses: state.exportLenses() }));
  assert.equal(parseContentBackup(JSON.stringify(raw)).libraries.lists?.length, 1);
  const previous = { filters: loadSavedFilters(), lists: loadListDefinitions(), lenses: state.exportLenses() };
  for (const kind of ['filters', 'lists', 'lenses']) {
    const duplicate = structuredClone(raw); duplicate.libraries[kind].push(structuredClone(duplicate.libraries[kind][0]));
    assert.throws(() => parseContentBackup(JSON.stringify(duplicate)), /Duplicate/);
    const malformed = structuredClone(raw); malformed.libraries[kind] = [null];
    assert.throws(() => parseContentBackup(JSON.stringify(malformed)));
  }
  const oldEnvelope = structuredClone(raw); oldEnvelope.version = 1;
  assert.throws(() => parseContentBackup(JSON.stringify(oldEnvelope)));
  const future = structuredClone(raw); future.libraries.filters[0].schemaVersion = 99;
  assert.throws(() => parseContentBackup(JSON.stringify(future)), /unsupported/);
  const futureList = structuredClone(raw);
  futureList.libraries.lists[0] = { format: 'ifc-lite-captured-list', version: 99, definition: raw.libraries.lists[0] };
  assert.throws(() => parseContentBackup(JSON.stringify(futureList)), /Invalid captured list/);
  const futureLens = structuredClone(raw);
  futureLens.libraries.lenses[0] = { format: 'ifc-lite-captured-lens', version: 99, lens: raw.libraries.lenses[0] };
  assert.throws(() => parseContentBackup(JSON.stringify(futureLens)), /unsupported saved lens/);
  assert.deepEqual({ filters: loadSavedFilters(), lists: loadListDefinitions(), lenses: state.exportLenses() }, previous);
});

for (const entry of entries) for (const collision of [false, true]) test(`#7218 native backup import restores captured ${entry.key}${collision ? ' beside conflicting local edits' : ''} through durable reload and its IFC engine`, async () => {
  await seedArtifactModels({ federated: true });
  await Promise.all([assistantLibrary.initialize(), useViewerStore.getState().initializeSavedClashReports()]);
  const models = new Map(useViewerStore.getState().models);
  for (const [id, model] of models) {
    const source = model.ifcDataStore!.source;
    const bytes = new Uint8Array(source.slice(0, source.byteLength));
    const sourceContentHash = await placementSourceIdentity(new Blob([bytes]), undefined, bytes);
    assert.ok(sourceContentHash);
    models.set(id, { ...model, sourceContentHash });
  }
  useViewerStore.setState({ models });
  const rules = [{ combinator: 'AND' as const, rules: [{ kind: 'ifcType' as const, op: 'in' as const, values: ['IfcWall', 'IfcWallStandardCase'] }] }];
  const rows = await evaluateFilterGroupsFederated(evaluatorModelsFromState(useViewerStore.getState()), rules, { limit: Infinity });
  const wall = rows.find(row => row.modelId === ARCH); assert.ok(wall); assert.ok(rows.length > 1);
  useViewerStore.getState().setSelectedEntity({ modelId: ARCH, expressId: wall.expressId });
  useViewerStore.getState().setSelectedEntityId(toGlobalIdFromModels(models, ARCH, wall.expressId));
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Captured native backup', kind: entry.kind, scope: 'selected', ...entry.body }), entry.kind);
  const preview = await previewArtifact(proposal, useViewerStore.getState());
  assert.equal(preview.matched, 1);
  const saved = saveArtifact(preview.artifact); assert.ok(saved.ok);
  const ui = render(<Notice />);
  const button = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Download library backup')); assert.ok(button);
  await waitFor(() => !button.disabled, 'native libraries finish loading');
  const blobs: Blob[] = [];
  const download = mock.method(URL, 'createObjectURL', (value: Blob | MediaSource) => {
    assert.ok(value instanceof Blob); blobs.push(value); return 'blob:native-captured-artifact-backup';
  });
  let text: string;
  try { click(button); await waitFor(() => blobs.length === 1, 'actual native captured backup download'); text = await blobs[0].text(); }
  finally { download.mock.restore(); }
  assert.equal(JSON.parse(text).version, 2, 'older native whole-backup readers must refuse the new complete backup');
  clearSavedFilters(); useViewerStore.getState().setListDefinitions([]); assert.deepEqual(loadListDefinitions(), []);
  assert.ok(useViewerStore.getState().setSavedLenses([]).ok);
  if (collision) {
    if (preview.artifact.kind === 'filter.proposal') {
      assert.ok(saveFilter(saved.saved.name, [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcSlab'] }] }]).persisted);
    } else if (preview.artifact.kind === 'list.proposal') {
      useViewerStore.getState().addListDefinition({ ...preview.artifact.definition, name: 'Locally edited wall names' });
    } else if (preview.artifact.kind === 'lens.proposal') {
      assert.ok(useViewerStore.getState().importLenses([{ ...preview.artifact.lens, name: 'Locally edited wall colors' }]).ok);
    }
  }
  const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { value: [new File([text], 'captured-library-backup.json')], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  const restoredName = collision && entry.key !== 'filters' ? `${saved.saved.name} (imported)` : saved.saved.name;
  await waitFor(() => entry.key === 'filters' ? loadSavedFilters().some(row => row.capturedScope && row.name.startsWith(saved.saved.name))
    : entry.key === 'lists' ? loadListDefinitions().some(row => row.name === restoredName || collision && row.name === saved.saved.name)
    : useViewerStore.getState().exportLenses().some(row => row.name === restoredName || collision && row.name === saved.saved.name), 'native import commits the actual artifact library');
  const state = useViewerStore.getState();
  if (entry.key === 'filters') {
    const filter = loadSavedFilters().find(row => row.capturedScope && row.name.startsWith(saved.saved.name)); assert.ok(filter);
    if (collision) {
      const original = loadSavedFilters().find(row => row.name === saved.saved.name); assert.ok(original);
      assert.ok((await previewFilterGroups(original.name, original.groups, state)).matched > 1, 'the conflicting local slab preset retains its own native population');
      assert.notEqual(filter.name, original.name);
    }
    assert.equal((await previewFilterGroups(filter.name, filter.groups, state, undefined, filter.capturedScope)).matched, 1);
    await assert.rejects(previewFilterGroups(filter.name, filter.groups, { ...state, models: new Map() }, undefined, filter.capturedScope), /Captured scope source is missing/);
  } else if (entry.key === 'lists') {
    const list = loadListDefinitions().find(row => row.name === restoredName); assert.ok(list);
    if (collision && preview.artifact.kind === 'list.proposal') {
      const originalId = preview.artifact.definition.id;
      assert.ok(loadListDefinitions().some(row => row.id === originalId && row.name === 'Locally edited wall names'));
      assert.notEqual(list.id, preview.artifact.definition.id);
    }
    const { pairs } = prepareListProviders(state, resolveRenderFrame(state.models, state.geometryResult));
    assert.equal((await runListFederated(list, pairs, state, { evaluatorModels: evaluatorModelsFromState(state) })).rows.length, 1);
    await assert.rejects(runListFederated(list, pairs, { ...state, models: new Map() }, { evaluatorModels: [] }), /Captured scope source is missing/);
  } else {
    const reloaded = createStore<LensSlice>()(createLensSlice);
    const lens = reloaded.getState().savedLenses.find(row => row.name === restoredName); assert.ok(lens);
    if (collision && preview.artifact.kind === 'lens.proposal') {
      const originalId = preview.artifact.lens.id;
      assert.ok(reloaded.getState().savedLenses.some(row => row.id === originalId && row.name === 'Locally edited wall colors'));
      assert.notEqual(lens.id, preview.artifact.lens.id);
    }
    const provider = createLensDataProvider(state.models, state.ifcDataStore, state.mutationViews, id => state.resolveGlobalIdFromModels(id));
    const matches = await evaluateLensGroups(lens, evaluatorModelsFromState(state), state.models, new Set(state.modelTags.keys()));
    assert.equal(evaluateLens(lens, provider, matches).colorMap.size, 1);
    await assert.rejects(evaluateLensGroups(lens, [], new Map(), new Set()), /Captured scope source is missing/);
  }
  const identities = { filters: loadSavedFilters().map(row => row.name), lists: loadListDefinitions().map(row => row.id),
    lenses: createStore<LensSlice>()(createLensSlice).getState().savedLenses.map(row => row.id) };
  await importNativeLibraries(parseContentBackup(text).libraries);
  if (collision && entry.key === 'filters') {
    assert.equal(loadSavedFilters().length, identities.filters.length + 1, 'without native import lineage a conflicting Filter retry preserves both independent existing names and creates another source copy');
    for (const name of identities.filters) assert.ok(loadSavedFilters().some(row => row.name === name));
    const next = loadSavedFilters().find(row => !identities.filters.includes(row.name)); assert.ok(next);
    assert.equal((await previewFilterGroups(next.name, next.groups, state, undefined, next.capturedScope)).matched, 1, 'the additional conflict copy retains the actual captured IFC population');
  } else {
    assert.deepEqual({ filters: loadSavedFilters().map(row => row.name), lists: loadListDefinitions().map(row => row.id),
      lenses: createStore<LensSlice>()(createLensSlice).getState().savedLenses.map(row => row.id) }, identities,
      'an unchanged native identity retry retains the independent copy identities');
  }
});

test('#7218 native matching Lens import verifies durability after its browser entry is removed', async () => {
  await seedArtifactModels({ federated: true });
  const entry = entries[2];
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native Lens durability', kind: entry.kind, ...entry.body }), entry.kind);
  const preview = await previewArtifact(proposal, useViewerStore.getState());
  assert.ok(preview.matched > 0, 'the real IFC engine establishes the imported Lens population');
  const saved = saveArtifact(preview.artifact); assert.ok(saved.ok);
  assert.ok(saved.saved.kind === 'lens.proposal');
  const savedId = saved.saved.id;
  const wire = await nativeBackupWire({ lenses: useViewerStore.getState().exportLenses() });
  localStorage.removeItem('ifc-lite-custom-lenses');
  assert.ok(useViewerStore.getState().savedLenses.some(row => row.id === savedId), 'the actual native session retains the Lens');
  assert.ok(!createStore<LensSlice>()(createLensSlice).getState().savedLenses.some(row => row.id === savedId), 'a fresh native reload establishes missing durability');
  const ui = render(<Notice />);
  const retry = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Retry all libraries')); assert.ok(retry);
  await waitFor(() => !retry.disabled, 'native libraries finish loading before import');
  const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { value: [new File([wire], 'matching-lens-backup.json')], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  await waitFor(() => !retry.disabled, 'the native matching Lens import finishes');
  assert.ok(!ui.textContent?.includes('Some saved Filters'), 'native import reports a durable success');
  const fresh = createStore<LensSlice>()(createLensSlice).getState().savedLenses;
  assert.equal(fresh.filter(row => row.id === savedId).length, 1, 'success must restore the matching Lens through a fresh native store reload');
});

test('#7218 Retry preserves a conflicting Filter already saved before a later Filter quota refusal', async () => {
  await seedArtifactModels({ federated: true });
  const entry = entries[0];
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native partial Filter retry', kind: entry.kind, ...entry.body }), entry.kind);
  const preview = await previewArtifact(proposal, useViewerStore.getState());
  assert.ok(preview.matched > 0, 'the real IFC engine establishes the backed-up population');
  assert.ok(saveArtifact(preview.artifact).ok);
  const first = loadSavedFilters()[0]; assert.ok(first);
  assert.ok(saveFilter('Backup second actual walls', first.groups, first.capturedScope).persisted);
  const wire = await nativeBackupWire({ filters: loadSavedFilters() });
  clearSavedFilters();
  assert.ok(saveFilter(first.name, [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcSlab'] }] }]).persisted);
  const ui = render(<Notice />);
  const retry = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Retry all libraries')); assert.ok(retry);
  await waitFor(() => !retry.disabled, 'native libraries finish loading before import');
  const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { value: [new File([wire], 'partial-filter-backup.json')], configurable: true });
  const original = localStorage.setItem.bind(localStorage);
  let writes = 0;
  const denied = mock.method(localStorage, 'setItem', (key: string, value: string) => {
    if (key === 'ifc-lite:search:saved-filters' && ++writes > 1) throw new DOMException('Native second Filter quota', 'QuotaExceededError');
    original(key, value);
  });
  let completed: ReturnType<typeof loadSavedFilters> = [];
  try {
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => !retry.disabled && ui.textContent?.includes('Some saved Filters') === true, 'the second Filter remains pending');
    completed = loadSavedFilters();
    assert.equal(completed.length, 2, 'the original local Filter and the first imported copy are durable');
    click(retry); await waitFor(() => !retry.disabled, 'the still-refused retry finishes');
    assert.deepEqual(loadSavedFilters(), completed, 'a partial Filter retry must preserve completed native entries');
  } finally { denied.mock.restore(); }
  click(retry);
  await waitFor(() => !retry.disabled && !ui.textContent?.includes('Some saved Filters'), 'Retry saves only the unfinished Filter');
  const rows = loadSavedFilters();
  assert.equal(rows.length, 3, 'one independent original, one completed collision copy, and one retried Filter');
  for (const row of completed) assert.deepEqual(rows.find(candidate => candidate.name === row.name), row);
  assert.ok(rows.some(row => row.name === 'Backup second actual walls'));
});

test('#7218 refused native Filter import cannot produce an incomplete successful download', async () => {
  await seedArtifactModels({ federated: true });
  await Promise.all([assistantLibrary.initialize(), useViewerStore.getState().initializeSavedClashReports()]);
  const entry = entries[0];
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native filter recovery', kind: entry.kind, ...entry.body }), entry.kind);
  const preview = await previewArtifact(proposal, useViewerStore.getState());
  assert.ok(preview.matched > 0); assert.ok(saveArtifact(preview.artifact).ok);
  const text = await nativeBackupWire({ filters: loadSavedFilters() });
  clearSavedFilters();
  const ui = render(<Notice />), input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  const retry = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Retry all libraries')); assert.ok(retry);
  const downloadButton = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Download library backup')); assert.ok(downloadButton);
  const original = localStorage.setItem.bind(localStorage), blobs: Blob[] = [];
  const download = mock.method(URL, 'createObjectURL', (value: Blob | MediaSource) => { assert.ok(value instanceof Blob); blobs.push(value); return 'blob:pending-native-filter'; });
  const denied = mock.method(localStorage, 'setItem', (key: string, value: string) => { if (key === 'ifc-lite:search:saved-filters') throw new DOMException('Native filter quota', 'QuotaExceededError'); original(key, value); });
  try {
    Object.defineProperty(input, 'files', { value: [new File([text], 'filter-A.json')], configurable: true });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => ui.textContent?.includes('Some saved Filters') === true && !retry.disabled, 'refused native Filter remains pending after import');
    assert.deepEqual(loadSavedFilters(), []);
    await act(async () => { downloadButton.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await waitFor(() => !retry.disabled, 'refused export callback finishes');
    assert.equal(blobs.length, 0, 'pending artifact must not be silently omitted from an apparently successful native backup');
    assert.ok(downloadButton.disabled, 'pending import has an explicit bounded export refusal');
  } finally { denied.mock.restore(); download.mock.restore(); }
  click(retry); await waitFor(() => loadSavedFilters().length === 1, 'native Retry persists the original refused Filter');
  await waitFor(() => !downloadButton.disabled, 'complete native backup becomes available only after recovery');
});

for (const entry of entries.filter(row => row.key === 'lists' || row.key === 'lenses')) test(`#7218 ${entry.key} collision copies reserve later source IDs and preserve edited copies on exact native retries`, async () => {
  await seedArtifactModels({ federated: true });
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native collision lineage', kind: entry.kind, ...entry.body }), entry.kind);
  const preview = await previewArtifact(proposal, useViewerStore.getState()); assert.ok(preview.matched > 0);
  assert.ok(saveArtifact(preview.artifact).ok);
  if (preview.artifact.kind !== 'list.proposal' && preview.artifact.kind !== 'lens.proposal') assert.fail('native identity-keyed library required');
  const incoming = preview.artifact.kind === 'list.proposal' ? preview.artifact.definition : preview.artifact.lens;
  const reserved = `ifc-lite-backup:1:${incoming.id}`, copyId = `ifc-lite-backup:2:${incoming.id}`;
  const sourceLibraries = preview.artifact.kind === 'list.proposal'
    ? { lists: [preview.artifact.definition, { ...preview.artifact.definition, id: reserved }] }
    : { lenses: [preview.artifact.lens, { ...preview.artifact.lens, id: reserved }] };
  // Actual guarded native codecs accept string IDs; no private storage surface.
  const wire = await nativeBackupWire(sourceLibraries);
  const decoded = parseContentBackup(wire).libraries;
  if (preview.artifact.kind === 'list.proposal') {
    useViewerStore.getState().setListDefinitions([{ ...preview.artifact.definition, name: 'Local edit retained' }]);
    assert.equal(loadListDefinitions()[0]?.name, 'Local edit retained');
  } else assert.ok(useViewerStore.getState().setSavedLenses([{ ...preview.artifact.lens, name: 'Local edit retained' }]).ok);
  const durable = () => entry.key === 'lists' ? loadListDefinitions() : createStore<LensSlice>()(createLensSlice).getState().savedLenses.filter(row => !row.builtin);
  await importNativeLibraries(decoded);
  const rows = durable();
  assert.deepEqual(rows.map(row => row.id).sort(), [incoming.id, reserved, copyId].sort(), 'copy cannot steal a later source identity');
  assert.equal(rows.find(row => row.id === incoming.id)?.name, 'Local edit retained');
  const snapshot = rows.map(row => ({ id: row.id, name: row.name }));
  await importNativeLibraries(decoded);
  assert.deepEqual(durable().map(row => ({ id: row.id, name: row.name })), snapshot, 'native deterministic copy IDs certify an unchanged retry');
  if (preview.artifact.kind === 'list.proposal') {
    useViewerStore.getState().setListDefinitions(loadListDefinitions().map(row => row.id === copyId ? { ...row, name: 'Edited independent copy' } : row));
    assert.equal(loadListDefinitions().find(row => row.id === copyId)?.name, 'Edited independent copy');
  } else assert.ok(useViewerStore.getState().setSavedLenses(useViewerStore.getState().exportLenses().map(row => row.id === copyId ? { ...row, name: 'Edited independent copy' } : row)).ok);
  await importNativeLibraries(decoded);
  const final = durable();
  assert.equal(final.find(row => row.id === copyId)?.name, 'Edited independent copy', 'retry must preserve local edits to the previous imported identity');
  const freshId = `ifc-lite-backup:3:${incoming.id}`;
  assert.ok(final.some(row => row.id === freshId), 'new unchanged source copy receives the next bounded native ID');
  const state = useViewerStore.getState();
  if (entry.key === 'lists') {
    const list = loadListDefinitions().find(row => row.id === freshId); assert.ok(list);
    const { pairs } = prepareListProviders(state, resolveRenderFrame(state.models, state.geometryResult));
    assert.equal((await runListFederated(list, pairs, state, { evaluatorModels: evaluatorModelsFromState(state) })).rows.length, preview.matched);
  } else {
    const lens = createStore<LensSlice>()(createLensSlice).getState().savedLenses.find(row => row.id === freshId); assert.ok(lens);
    const matches = await evaluateLensGroups(lens, evaluatorModelsFromState(state), state.models, new Set(state.modelTags.keys()));
    assert.ok(evaluateLens(lens, createLensDataProvider(state.models, state.ifcDataStore, state.mutationViews, id => state.resolveGlobalIdFromModels(id)), matches).colorMap.size > 0);
  }
});

for (const entry of entries.filter(row => row.key === 'lists' || row.key === 'lenses')) test(`#7218 native ${entry.key} original-ID rename to an imported-looking name remains an independent local edit`, async () => {
  await seedArtifactModels({ federated: true });
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native renamed identity witness', kind: entry.kind, ...entry.body }), entry.kind);
  const preview = await previewArtifact(proposal, useViewerStore.getState()); assert.ok(preview.matched > 0);
  assert.ok(saveArtifact(preview.artifact).ok);
  if (preview.artifact.kind !== 'list.proposal' && preview.artifact.kind !== 'lens.proposal') assert.fail('native identity keyed artifact required');
  const incoming = preview.artifact.kind === 'list.proposal' ? preview.artifact.definition : preview.artifact.lens;
  const localName = `${incoming.name} (imported)`;
  if (preview.artifact.kind === 'list.proposal') {
    useViewerStore.getState().setListDefinitions([{ ...preview.artifact.definition, name: localName }]);
    assert.equal(loadListDefinitions()[0]?.name, localName);
  }
  else assert.ok(useViewerStore.getState().setSavedLenses([{ ...preview.artifact.lens, name: localName }]).ok);
  await importNativeLibraries(preview.artifact.kind === 'list.proposal' ? { lists: [preview.artifact.definition] } : { lenses: [preview.artifact.lens] });
  const rows = entry.key === 'lists' ? loadListDefinitions() : createStore<LensSlice>()(createLensSlice).getState().savedLenses.filter(row => !row.builtin);
  assert.equal(rows.length, 2, 'same-ID renamed local artifact cannot consume the unchanged incoming artifact');
  assert.equal(rows.find(row => row.id === incoming.id)?.name, localName, 'native local rename is preserved');
  assert.ok(rows.some(row => row.id !== incoming.id), 'incoming definition receives its own native collision identity');
});

test('#7218 native independently saved Filter imported-looking name cannot consume an incoming Filter', async () => {
  await seedArtifactModels({ federated: true });
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native filter identity witness', kind: 'filter.proposal', ...entries[0].body }), 'filter.proposal');
  const preview = await previewArtifact(proposal, useViewerStore.getState()); assert.ok(preview.matched > 0);
  assert.ok(saveArtifact(preview.artifact).ok);
  const incoming = loadSavedFilters()[0]; assert.ok(incoming);
  clearSavedFilters(); assert.ok(saveFilter(`${incoming.name} (imported)`, incoming.groups, incoming.capturedScope).persisted);
  await importNativeLibraries({ filters: [incoming] });
  const rows = loadSavedFilters();
  assert.equal(rows.length, 2, 'an independent suffix-named Filter cannot substitute for the source Filter');
  assert.ok(rows.some(row => row.name === incoming.name));
  assert.ok(rows.some(row => row.name === `${incoming.name} (imported)`));
  const actual = await previewFilterGroups(incoming.name, rows.find(row => row.name === incoming.name)!.groups, useViewerStore.getState());
  assert.equal(actual.matched, preview.matched, 'actual imported Filter retains its real native IFC population');
});


test('#7218 native Filter collision copies reserve every incoming source name', async () => {
  await seedArtifactModels({ federated: true });
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native incoming Filter identity reservation', kind: 'filter.proposal', ...entries[0].body }), 'filter.proposal');
  const preview = await previewArtifact(proposal, useViewerStore.getState()); assert.ok(preview.matched > 0);
  assert.ok(saveArtifact(preview.artifact).ok);
  const source = loadSavedFilters()[0]; assert.ok(source);
  assert.ok(saveFilter(`${source.name} (imported)`, source.groups, source.capturedScope).persisted);
  const sibling = loadSavedFilters().find(row => row.name === `${source.name} (imported)`); assert.ok(sibling);
  clearSavedFilters();
  assert.ok(saveFilter(source.name, [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcSlab'] }] }]).persisted);
  await importNativeLibraries({ filters: [sibling, source] });
  const rows = loadSavedFilters();
  assert.equal(rows.length, 3, 'the native conflicting local Filter and both independently named source Filters must survive');
  for (const name of [sibling.name, `${source.name} (imported 2)`]) {
    const row = rows.find(candidate => candidate.name === name); assert.ok(row);
    assert.equal((await previewFilterGroups(name, row.groups, useViewerStore.getState())).matched, preview.matched);
  }
});

test('#7218 cancelling a refused import explicitly releases whole-backup download without losing saved content', async () => {
  await seedArtifactModels({ federated: true });
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native cancelled import recovery', kind: 'filter.proposal', ...entries[0].body }), 'filter.proposal');
  const preview = await previewArtifact(proposal, useViewerStore.getState()); assert.ok(preview.matched > 0);
  assert.ok(saveArtifact(preview.artifact).ok);
  const wire = await nativeBackupWire({ filters: loadSavedFilters() });
  clearSavedFilters();
  const ui = render(<><Notice /><ConfirmDialogHost /></>);
  const retry = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Retry all libraries')); assert.ok(retry);
  await waitFor(() => !retry.disabled, 'native libraries finish loading before import');
  const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { value: [new File([wire], 'cancelled-import-backup.json')], configurable: true });
  const original = localStorage.setItem.bind(localStorage), blobs: Blob[] = [];
  const denied = mock.method(localStorage, 'setItem', (key: string, value: string) => {
    if (key === 'ifc-lite:search:saved-filters') throw new DOMException('Persistent native Filter quota', 'QuotaExceededError');
    original(key, value);
  });
  const download = mock.method(URL, 'createObjectURL', (value: Blob | MediaSource) => { assert.ok(value instanceof Blob); blobs.push(value); return 'blob:cancelled-import-recovery'; });
  try {
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await waitFor(() => !retry.disabled && ui.textContent?.includes('Some saved Filters') === true, 'the native refused import remains pending');
    const cancelImport = [...ui.querySelectorAll('button')].find(node => node.textContent === 'Cancel unfinished import'); assert.ok(cancelImport, 'a refused import needs an explicit recovery action');
    click(cancelImport);
    await waitFor(() => document.querySelector('[role="alertdialog"]') !== null, 'actual native confirmation appears');
    let dialog = document.querySelector('[role="alertdialog"]'); assert.ok(dialog);
    assert.ok(dialog.textContent?.includes('Keep the original backup file'));
    const cancel = [...dialog.querySelectorAll('button')].find(node => node.textContent === 'Cancel'); assert.ok(cancel); click(cancel);
    await waitFor(() => !cancelImport.disabled, 'cancelled confirmation finishes');
    assert.ok(ui.textContent?.includes('Some saved Filters'), 'declining cancellation retains the unfinished import');
    click(cancelImport); await waitFor(() => document.querySelector('[role="alertdialog"]') !== null, 'second native confirmation appears');
    dialog = document.querySelector('[role="alertdialog"]'); assert.ok(dialog);
    const confirm = [...dialog.querySelectorAll('button')].find(node => node.textContent === 'Cancel unfinished import'); assert.ok(confirm); click(confirm);
    await waitFor(() => !ui.textContent?.includes('Some saved Filters'), 'explicit confirmation clears only unfinished artifacts');
    const button = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Download library backup')); assert.ok(button);
    await waitFor(() => !button.disabled, 'whole-backup recovery becomes available despite persistent write refusal');
    click(button); await waitFor(() => blobs.length === 1, 'actual native recovery download');
    const recovered = parseContentBackup(await blobs[0].text());
    assert.equal(recovered.libraries.filters?.length ?? 0, 0, 'cancelled unsaved entries are not falsely represented as saved');
    assert.deepEqual(parseContentBackup(wire).libraries.filters?.length, 1, 'the original source file still contains the refused Filter');
  } finally { denied.mock.restore(); download.mock.restore(); }
});
