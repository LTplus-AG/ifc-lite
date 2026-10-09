/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { act } from 'react';
import { createStore } from 'zustand/vanilla';
import { useViewerStore } from '@/store';
import { createListSlice, type ListSlice } from '@/store/slices/listSlice';
import { createLensSlice, type LensSlice } from '@/store/slices/lensSlice';
import { cleanup, click, render, waitFor } from '@/test/render';
import { seedArtifactModels } from '@/test/artifact-models-fixture';
import { assistantLibrary } from '@/lib/assistant/library';
import { parseArtifactProposal } from '@/lib/assistant/artifacts/proposal-kinds';
import { previewArtifact } from '@/lib/assistant/artifacts/artifact-preview';
import { saveArtifact } from '@/lib/assistant/artifacts/artifact-save';
import { createContentBackup, encodeContentBackup } from '@/lib/storage/content-backup';
import { loadListDefinitions } from '@/lib/lists/persistence';
import { ContentStorageNotice } from './ContentStorageNotice';

const groups = [{ combinator: 'AND', rules: [{ kind: 'ifcType', op: 'in', values: ['IfcWall', 'IfcWallStandardCase'] }] }];
const families = [
  { kind: 'list.proposal', key: 'ifc-lite-lists', library: 'lists', body: { list: { name: 'Native IFC wall List', entityTypes: ['IfcWall'], groups, columns: [{ id: 'name', source: 'attribute', propertyName: 'Name' }] } } },
  { kind: 'lens.proposal', key: 'ifc-lite-custom-lenses', library: 'lenses', body: { lens: { name: 'Native IFC wall Lens', rules: [{ name: 'Walls', groups, action: 'colorize', color: '#123456' }] } } },
] as const;
const states = ['absent', 'readable', 'corrupt-json', 'wrong-shape', 'empty-string', 'future-format', 'mixed-future', 'read-denied'] as const;
function Notice() {
  const status = useViewerStore(state => state.documentsStorage);
  return <ContentStorageNotice status={status} retry={() => useViewerStore.getState().retryDocumentsSave()}
    restore={() => useViewerStore.getState().restoreDocuments()} />;
}
beforeEach(() => { localStorage.clear(); useViewerStore.getState().setListDefinitions([]); useViewerStore.getState().setSavedLenses([]); });
afterEach(() => { cleanup(); localStorage.clear(); });

for (const family of families) for (const bucket of states) test(`#7300 native backup preserves ${family.library} local ${bucket} source`, async () => {
  await seedArtifactModels({ federated: true });
  await Promise.all([assistantLibrary.initialize(), useViewerStore.getState().initializeSavedClashReports()]);
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native unreadable-source probe', kind: family.kind, ...family.body }), family.kind);
  const preview = await previewArtifact(proposal, useViewerStore.getState());
  assert.ok(preview.matched > 0, 'actual native IFC engine establishes useful saved artifact before storage probe');
  assert.ok(saveArtifact(preview.artifact).ok);
  const state = useViewerStore.getState();
  const nativeRows = family.library === 'lists' ? loadListDefinitions() : state.exportLenses().filter(row => row.name === 'Native IFC wall Lens');
  assert.equal(nativeRows.length, 1);
  const text = JSON.stringify(encodeContentBackup(createContentBackup({ validation: [], comparison: [], document: [],
    ...(family.library === 'lists' ? { lists: nativeRows as ReturnType<typeof loadListDefinitions> } : { lenses: state.exportLenses().filter(row => row.name === 'Native IFC wall Lens') }) })));
  const originalRead = localStorage.getItem.bind(localStorage);
  const savedRaw = originalRead(family.key); assert.ok(savedRaw);
  const parsed: unknown = JSON.parse(savedRaw); assert.ok(Array.isArray(parsed) && parsed.length === 1);
  const future = family.library === 'lists'
    ? { format: 'ifc-lite-captured-list', version: 99, definition: nativeRows[0] }
    : { format: 'ifc-lite-captured-lens', version: 99, lens: nativeRows[0] };
  const raw = bucket === 'absent' ? null : bucket === 'wrong-shape' ? JSON.stringify({ knownNativeOriginal: parsed[0] }) : bucket === 'empty-string' ? '' : bucket === 'corrupt-json' ? `${savedRaw.slice(0, -1)} unfinished`
    : bucket === 'future-format' ? JSON.stringify([future])
    : bucket === 'mixed-future' ? JSON.stringify([...parsed, future]) : savedRaw;
  if (raw === null) localStorage.removeItem(family.key); else localStorage.setItem(family.key, raw);
  const denied = bucket === 'read-denied' ? mock.method(localStorage, 'getItem', (key: string) => {
    if (key === family.key) throw new DOMException('Native local read denied', 'SecurityError');
    return originalRead(key);
  }) : null;
  try {
    // Actual native startup loaders determine the new session's known rows.
    if (family.library === 'lists') {
      const loaded = createStore<ListSlice>()(createListSlice).getState();
      useViewerStore.setState({ listDefinitions: loaded.listDefinitions, listDefinitionSource: loaded.listDefinitionSource });
      assert.equal(loaded.listDefinitions.length, bucket === 'readable' || bucket === 'mixed-future' ? 1 : 0);
    } else {
      const loaded = createStore<LensSlice>()(createLensSlice).getState();
      useViewerStore.setState({ savedLenses: loaded.savedLenses });
      assert.equal(loaded.savedLenses.filter(row => !row.builtin).length, bucket === 'readable' || bucket === 'mixed-future' ? 1 : 0);
    }
    assert.equal(originalRead(family.key), raw, 'native loader initially preserves actual unknown source bytes');
    const ui = render(<Notice />);
    const input = ui.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
    Object.defineProperty(input, 'files', { value: [new File([text], 'native-known-backup.json')], configurable: true });
    const button = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Download library backup')); assert.ok(button);
    await waitFor(() => !button.disabled, 'native library widget startup');
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    const retryReady = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Retry all libraries')); assert.ok(retryReady);
    await waitFor(() => !retryReady.disabled, 'native widget finishes restore; pending sources block complete export');
    if (bucket === 'readable' || bucket === 'absent') {
      const loaded = family.library === 'lists' ? loadListDefinitions() : createStore<LensSlice>()(createLensSlice).getState().savedLenses.filter(row => !row.builtin);
      assert.deepEqual(loaded.map(row => row.id), nativeRows.map(row => row.id), 'readable native library survives canonical migration and idempotent import');
    } else assert.equal(originalRead(family.key), raw, 'valid backup import must not overwrite unreadable existing local library bytes');
    if (bucket !== 'readable' && bucket !== 'absent') {
      assert.ok(ui.textContent?.includes('Some saved Filters'), 'unknown source refusal remains pending and recoverable');
      // Explicit repair restores the actual original native bytes; retry must
      // re-read the source rather than retain a permanently latched failure.
      denied?.mock.restore();
      localStorage.setItem(family.key, savedRaw);
      const retry = [...ui.querySelectorAll('button')].find(node => node.textContent?.includes('Retry all libraries')); assert.ok(retry);
      click(retry);
      await waitFor(() => !ui.textContent?.includes('Some saved Filters'), 'native retry succeeds after explicit source repair');
      const restored = family.library === 'lists' ? loadListDefinitions() : createStore<LensSlice>()(createLensSlice).getState().savedLenses.filter(row => !row.builtin);
      assert.deepEqual(restored.map(row => row.id), nativeRows.map(row => row.id), 'repair and retry retain the native identity without duplicate imports');
    }
  } finally { denied?.mock.restore(); }
});

for (const family of families) test(`#7300 native ${family.library} CRUD refuses a newly unreadable source after a successful startup`, async () => {
  await seedArtifactModels();
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native CRUD source guard', kind: family.kind, ...family.body }), family.kind);
  const preview = await previewArtifact(proposal, useViewerStore.getState()); assert.ok(preview.matched > 0);
  assert.ok(saveArtifact(preview.artifact).ok);
  const state = useViewerStore.getState();
  const originals = family.library === 'lists' ? loadListDefinitions() : state.exportLenses().filter(row => row.name === 'Native IFC wall Lens');
  const unknown = JSON.stringify({ unrecognizedFutureLibrary: originals });
  localStorage.setItem(family.key, unknown);
  if (family.library === 'lists') {
    state.updateListDefinition(originals[0].id, { name: 'Unsaved native draft' });
    assert.ok(useViewerStore.getState().listError?.includes('Originals were left untouched'));
    assert.equal(localStorage.getItem(family.key), unknown);
    state.deleteListDefinition(originals[0].id);
    assert.ok(useViewerStore.getState().listError?.includes('Originals were left untouched'));
  } else {
    const before = state.savedLenses;
    for (const result of [state.updateLens(originals[0].id, { name: 'Refused native draft' }), state.duplicateLens(originals[0].id), state.deleteLens(originals[0].id)]) {
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.message.includes('Originals were left untouched'));
    }
    assert.equal(useViewerStore.getState().savedLenses, before, 'refused native Lens CRUD cannot publish a fictitious saved copy');
  }
  assert.equal(localStorage.getItem(family.key), unknown, 'all native actions preserve actual unreadable source bytes');
});

for (const family of families) test(`#7300 native ${family.library} final write refuses source replacement during serialization`, async () => {
  await seedArtifactModels();
  const proposal = parseArtifactProposal(JSON.stringify({ version: 1, title: 'Native source revision guard', kind: family.kind, ...family.body }), family.kind);
  const preview = await previewArtifact(proposal, useViewerStore.getState()); assert.ok(preview.matched > 0);
  assert.ok(saveArtifact(preview.artifact).ok);
  const state = useViewerStore.getState();
  const original = family.library === 'lists' ? loadListDefinitions()[0] : state.exportLenses().find(row => row.name === 'Native IFC wall Lens'); assert.ok(original);
  const replacement = JSON.stringify({ futureOwnedLibrary: [original] });
  const next = { ...original, id: crypto.randomUUID(), name: 'Native serialization candidate' };
  Object.defineProperty(next, 'toJSON', { value: () => {
    localStorage.setItem(family.key, replacement);
    return { ...next };
  } });
  if (family.library === 'lists') {
    assert.ok('columns' in next);
    assert.equal(state.setListDefinitions([next]), false);
    assert.ok(useViewerStore.getState().listError?.includes('changed while saving'));
  } else {
    assert.ok('rules' in next);
    const saved = state.createLens(next);
    assert.equal(saved.ok, false);
    assert.ok(!saved.ok && saved.message.includes('changed while saving'));
  }
  assert.equal(localStorage.getItem(family.key), replacement, 'final native write leaves the replacement actual source untouched');
});
