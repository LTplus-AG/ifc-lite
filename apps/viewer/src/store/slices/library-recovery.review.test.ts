/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { createStore } from 'zustand/vanilla';
import type { ListDefinition } from '@ifc-lite/lists';
import type { Lens } from '@ifc-lite/lens';
import { createListSlice, type ListSlice } from './listSlice.js';
import { createLensSlice, buildInitialLenses, type LensSlice } from './lensSlice.js';
import { loadListDefinitions, saveListDefinitions } from '@/lib/lists/persistence';
import { migrateSavedLens } from '@/lib/lens/migrate-saved-lens';
import { useViewerStore } from '@/store';
import { createContentBackup } from '@/lib/storage/content-backup';
import { currentListDefinitions, importArtifactLibraries } from '@/lib/storage/artifact-backup-import';
const list = (id: string): ListDefinition => ({ id, name: id, entityTypes: [], columns: [{ id: 'Name', source: 'attribute', propertyName: 'Name' }], groups: [], createdAt: 1, updatedAt: 1 });
const lens = (id: string): Lens => ({ id, name: id, rules: [] });
afterEach(() => { mock.restoreAll(); localStorage.clear(); });
for (const kind of ['lists', 'lenses'] as const) test(`#7300 ${kind} startup read denial followed by native creation retains recovered durable peers`, () => {
  localStorage.clear();
  const key = kind === 'lists' ? 'ifc-lite-lists' : 'ifc-lite-custom-lenses';
  localStorage.setItem(key, JSON.stringify([kind === 'lists' ? list('recovered') : lens('recovered')]));
  const read = localStorage.getItem.bind(localStorage);
  const denied = mock.method(localStorage, 'getItem', (requested: string) => {
    if (requested === key) throw new DOMException('Read denied', 'SecurityError');
    return read(requested);
  });
  const lists = kind === 'lists' ? createStore<ListSlice>()(createListSlice) : null;
  const lenses = kind === 'lenses' ? createStore<LensSlice>()(createLensSlice) : null;
  denied.mock.restore();
  if (lists) lists.getState().addListDefinition(list('new'));
  if (lenses) assert.ok(lenses.getState().createLens(lens('new')).ok);
  const loaded = kind === 'lists' ? loadListDefinitions() : buildInitialLenses().filter(row => !row.builtin);
  assert.deepEqual(loaded.map(row => row.id).sort(), ['new', 'recovered']);
  const visible = lists?.getState().listDefinitions ?? lenses?.getState().savedLenses.filter(row => !row.builtin);
  assert.deepEqual(visible?.map(row => row.id).sort(), ['new', 'recovered']);
});
test('#7300 empty Lens IDs have the same unavailable migration contract before and after the source reader', () => {
  const input = { ...lens(''), name: 'Legacy empty identity' };
  assert.equal(migrateSavedLens(input)?.id, undefined, 'the canonical pre-existing migration rejects an empty identity');
  localStorage.setItem('ifc-lite-custom-lenses', JSON.stringify([input]));
  assert.deepEqual(buildInitialLenses().filter(row => !row.builtin), [], 'the native startup reader cannot assign the missing migrated identity');
  assert.ok(localStorage.getItem('ifc-lite-custom-lenses')?.includes('Legacy empty identity'));
});
test('#7300 native List delete after a peer addition preserves the peer and intentional deletion', () => {
  assert.ok(saveListDefinitions([list('original')]));
  const state = createStore<ListSlice>()(createListSlice);
  assert.ok(saveListDefinitions([list('original'), list('peer')]));
  state.getState().deleteListDefinition('original');
  assert.deepEqual(loadListDefinitions().map(row => row.id), ['peer']);
});

for (const kind of ['lists', 'lenses'] as const) test(`#7300 native ${kind} import retry preserves an independent repaired entry`, () => {
  localStorage.clear();
  if (kind === 'lists') {
    const loaded = createStore<ListSlice>()(createListSlice);
    loaded.getState().addListDefinition(list('backup-A'));
    useViewerStore.setState({ listDefinitions: loaded.getState().listDefinitions, listDefinitionSource: loaded.getState().listDefinitionSource });
  } else {
    const loaded = createStore<LensSlice>()(createLensSlice);
    assert.ok(loaded.getState().createLens(lens('backup-A')).ok);
    useViewerStore.setState({ savedLenses: loaded.getState().savedLenses });
  }
  const key = kind === 'lists' ? 'ifc-lite-lists' : 'ifc-lite-custom-lenses';
  localStorage.setItem(key, '{unfinished');
  const incoming = kind === 'lists' ? { lists: [list('backup-A')] } : { lenses: [lens('backup-A')] };
  assert.deepEqual(importArtifactLibraries(incoming).failed, [kind]);
  localStorage.setItem(key, JSON.stringify([kind === 'lists' ? list('recovered-B') : lens('recovered-B')]));
  assert.deepEqual(importArtifactLibraries(incoming).failed, []);
  const read = () => kind === 'lists' ? loadListDefinitions() : buildInitialLenses().filter(row => !row.builtin);
  assert.deepEqual(read().map(row => row.id).sort(), ['backup-A', 'recovered-B']);
  importArtifactLibraries(kind === 'lists' ? { lists: [] } : { lenses: [] });
  assert.deepEqual(read().map(row => row.id).sort(), ['backup-A', 'recovered-B'], 'empty incoming rows cannot delete repaired durable entries');
});
test('#7300 conflicting recovered List edits refuse durable overwrite and retain the genuine draft', () => {
  localStorage.clear();
  assert.ok(saveListDefinitions([list('same')]));
  const state = createStore<ListSlice>()(createListSlice);
  assert.ok(saveListDefinitions([{ ...list('same'), name: 'Durable peer edit' }]));
  state.getState().updateListDefinition('same', { name: 'Session edit' });
  assert.equal(loadListDefinitions()[0].name, 'Durable peer edit');
  assert.equal(state.getState().listDefinitions[0].name, 'Session edit');
  assert.ok(state.getState().listError?.includes('changed independently'));
  assert.equal(state.getState().listDefinitionSource[0].name, 'same');
});

test('#7300 unrelated native Lens save retains the active ephemeral column Lens without persisting it', () => {
  localStorage.clear();
  const state = createStore<LensSlice>()(createLensSlice);
  state.getState().activateAutoColorFromColumn({ source: 'ifcType' }, 'IFC class');
  assert.ok(state.getState().createLens(lens('saved')).ok);
  assert.ok(state.getState().getActiveLens(), 'native transient color owner remains usable');
  assert.deepEqual(buildInitialLenses().filter(row => !row.builtin).map(row => row.id), ['saved']);
});

for (const action of ['backup', 'unrelated-create'] as const) test(`#7300 native Lists ${action} preserves every valid duplicate-ID row`, () => {
  localStorage.clear();
  const originals = [{ ...list('shared'), name: 'First independent List' }, { ...list('shared'), name: 'Second independent List' }];
  assert.ok(saveListDefinitions(originals));
  const loaded = createStore<ListSlice>()(createListSlice);
  assert.equal(loaded.getState().listDefinitions.length, 2, 'the existing native codec retains both individually valid rows');
  useViewerStore.setState({ listDefinitions: loaded.getState().listDefinitions, listDefinitionSource: loaded.getState().listDefinitionSource });
  if (action === 'backup') {
    const rows = currentListDefinitions(true);
    assert.deepEqual(rows.map(row => row.name), originals.map(row => row.name));
    assert.throws(() => createContentBackup({ validation: [], comparison: [], document: [], lists: rows }), /Duplicate list IDs/, 'the existing native portable format refuses duplicate identities rather than exporting a falsely complete subset');
    assert.deepEqual(loadListDefinitions().map(row => row.name), originals.map(row => row.name));
  } else {
    loaded.getState().addListDefinition(list('unrelated'));
    assert.deepEqual(loadListDefinitions().map(row => row.name), [...originals.map(row => row.name), 'unrelated']);
  }
});

test('#7300 native Lens creation retains both valid same-ID custom rows', () => {
  localStorage.clear();
  const originals = [{ ...lens('shared'), name: 'First Lens' }, { ...lens('shared'), name: 'Second Lens' }];
  localStorage.setItem('ifc-lite-custom-lenses', JSON.stringify(originals));
  const loaded = createStore<LensSlice>()(createLensSlice);
  assert.equal(loaded.getState().savedLenses.filter(row => !row.builtin).length, 2);
  assert.ok(loaded.getState().createLens(lens('unrelated')).ok);
  assert.deepEqual(buildInitialLenses().filter(row => !row.builtin).map(row => row.name), ['First Lens', 'Second Lens', 'unrelated']);
});
test('#7300 exact native duplicate-ID List delete preserves unrelated rows and refuses a changed durable group', () => {
  localStorage.clear();
  const originals = [{ ...list('shared'), name: 'First' }, { ...list('shared'), name: 'Second' }, list('unrelated')];
  assert.ok(saveListDefinitions(originals));
  const loaded = createStore<ListSlice>()(createListSlice);
  const repaired = [{ ...originals[0], name: 'Recovered first' }, ...originals.slice(1)];
  assert.ok(saveListDefinitions(repaired));
  loaded.getState().deleteListDefinition('shared');
  assert.deepEqual(loadListDefinitions().map(row => row.name), repaired.map(row => row.name), 'a recovered non-final member cannot be silently deleted by a stale group');
  assert.ok(loaded.getState().listError?.includes('changed independently'));
  const fresh = createStore<ListSlice>()(createListSlice);
  fresh.getState().deleteListDefinition('shared');
  assert.equal(fresh.getState().listError, null);
  assert.deepEqual(loadListDefinitions().map(row => row.id), ['unrelated'], 'the native ID-scoped delete still removes the exact complete captured group');
});
