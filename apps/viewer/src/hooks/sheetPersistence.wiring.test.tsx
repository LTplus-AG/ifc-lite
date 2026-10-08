/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Uses only pre-existing entrypoints so reverting #4836 fails a behavior
// assertion rather than a missing import. The stored JSON is our browser
// persistence contract, exercised through the real drawing lifecycle.
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { cleanup, render } from '@/test/render';
import { useDrawing2DPersistence } from './useDrawing2DPersistence';
import { placementSourceIdentity } from '@/lib/model-placement/source-identity';
import type { DrawingSheet } from '@ifc-lite/drawing-2d';

afterEach(cleanup);
function DrawingPersistenceProbe() { useDrawing2DPersistence(); return null; }

it('restores sheet setup and global templates through the drawing lifecycle (#4836)', async () => {
  localStorage.clear();
  useViewerStore.getState().createSheet({ paperId: 'A4_PORTRAIT' });
  useViewerStore.getState().updateTitleBlockField('project-name', 'Saved project');
  const expected = useViewerStore.getState().activeSheet!;
  const a = { ...fixtureModel('real-hash-a'), sourceFile: new File(['ISO-10303-21;sheet-model-a'], 'a.ifc') };
  const hash = await placementSourceIdentity(a.sourceFile);
  assert.ok(hash);
  const key = `ifc-lite:drawing-sheet:v1:${hash}`;
  localStorage.setItem(key, JSON.stringify({ sheet: expected, savedAt: 1 }));
  localStorage.setItem('ifc-lite:sheet-templates:v1', JSON.stringify({ templates: [{ ...expected, id: 'template-global' }] }));
  useViewerStore.setState({ activeSheet: null, savedSheetTemplates: [], sheetEnabled: false, models: new Map([[a.id, a]]), activeModelId: a.id });
  render(<DrawingPersistenceProbe />);
  for (let i = 0; i < 100 && !useViewerStore.getState().activeSheet; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  assert.deepEqual(useViewerStore.getState().activeSheet, expected);
  assert.equal(useViewerStore.getState().savedSheetTemplates[0].id, 'template-global');
  act(() => useViewerStore.getState().updateTitleBlockField('project-name', 'Updated via action'));
  const saved = JSON.parse(localStorage.getItem(key)!) as { sheet: DrawingSheet };
  assert.equal(saved.sheet.titleBlock.fields.find((field) => field.id === 'project-name')?.value, 'Updated via action');

  // Replacement bytes may arrive under the same model id. The old cached
  // hash must not restore or overwrite the previous file's sheet.
  const replacement = { ...a, sourceFile: new File(['ISO-10303-21;replacement'], 'a.ifc') };
  const replacementHash = await placementSourceIdentity(replacement.sourceFile);
  assert.ok(replacementHash);
  const replacementSheet = { ...expected, name: 'Replacement sheet' };
  localStorage.setItem(`ifc-lite:drawing-sheet:v1:${replacementHash}`, JSON.stringify({ sheet: replacementSheet, savedAt: 2 }));
  act(() => useViewerStore.setState({ models: new Map([[a.id, replacement]]) }));
  assert.equal(useViewerStore.getState().activeSheet, null);
  for (let i = 0; i < 100 && !useViewerStore.getState().activeSheet; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  assert.deepEqual(useViewerStore.getState().activeSheet, replacementSheet);
  assert.equal((JSON.parse(localStorage.getItem(key)!) as { sheet: DrawingSheet }).sheet.titleBlock.fields[0].value, 'Updated via action');
});
