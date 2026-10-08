/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { cleanup, click, mouseDown, render, type, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { loadSavedScripts } from '@/lib/scripts/persistence';
import { loadSavedFlows } from '@/lib/flow/persistence';
import { SearchModal } from './SearchModal';
import { nativeLibraryCatalogue, searchNativeLibraries } from '@/lib/libraries/native-catalogue';
import { openNativeLibraryArtifact } from '@/lib/libraries/open-native-artifact';
import { useLibraryFocus } from '@/lib/libraries/library-focus';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); localStorage.clear(); useLibraryFocus.setState({ target: null }); useViewerStore.setState(initial, true); });

test('#7235 shared library search is reachable with native saved scripts and Flows and no loaded IFC', () => {
  useViewerStore.setState({ models: new Map(), savedScripts: [], savedFlows: [], searchModalOpen: true });
  const state = useViewerStore.getState();
  const script = state.createScript('Coordination script', 'bim.query.all("IfcWall")');
  const flow = state.createFlow('Coordination workflow');
  assert.ok(loadSavedScripts().some(entry => entry.id === script), 'native script persistence completed');
  assert.ok(loadSavedFlows().some(entry => entry.doc.id === flow), 'native Flow persistence completed');
  render(<SearchModal />);
  assert.ok([...document.querySelectorAll('[role="tab"]')].some(tab => tab.textContent === 'Libraries'),
    'shared library search must remain reachable without a loaded model');
});

test('#7235 mounted library search spans native persisted scripts/Flows and opens the exact script without execution', async () => {
  useViewerStore.setState({ models: new Map(), savedScripts: [], savedFlows: [], searchModalOpen: true, scriptEditorDirty: false });
  const script = useViewerStore.getState().createScript('Coordination script', 'bim.query.all("IfcWall")');
  const flow = useViewerStore.getState().createFlow('Coordination workflow');
  assert.ok(loadSavedScripts().some(entry => entry.id === script));
  assert.ok(loadSavedFlows().some(entry => entry.doc.id === flow));
  render(<SearchModal />);
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent === 'Libraries');
  assert.ok(tab); mouseDown(tab);
  await waitFor(() => Boolean(document.querySelector('input[aria-label="Search saved artifact names and types"]')), 'native Libraries tab');
  type(document.querySelector('input[aria-label="Search saved artifact names and types"]') as HTMLInputElement, 'Coordination');
  const rows = document.querySelector('ul[aria-label="Saved artifacts"]');
  assert.ok(rows);
  assert.match(rows.textContent ?? '', /Coordination script/);
  assert.match(rows.textContent ?? '', /Coordination workflow/);
  const open = [...rows.querySelectorAll('button')].find(button => button.textContent === 'Coordination script');
  assert.ok(open); click(open);
  await waitFor(() => !useViewerStore.getState().searchModalOpen, 'native artifact opened');
  assert.equal(useViewerStore.getState().activeScriptId, script);
  assert.equal(useViewerStore.getState().scriptEditorContent, 'bim.query.all("IfcWall")');
  assert.equal(useViewerStore.getState().scriptExecutionState, 'idle');
  assert.equal(useViewerStore.getState().flowRunning, false);
  assert.equal(useViewerStore.getState().flowLastRun, null);
});

test('#7235 native dirty editor and changed/deleted saved targets refuse catalogue handoff', async () => {
  useViewerStore.setState({ savedScripts: [], savedFlows: [], scriptEditorDirty: false, flowDirty: false });
  const script = useViewerStore.getState().createScript('Original script', 'bim.query.all("IfcWall")');
  const flow = useViewerStore.getState().createFlow('Saved workflow');
  const groups = nativeLibraryCatalogue(useViewerStore.getState(), { phase: 'unavailable', entries: [] });
  const scriptTarget = searchNativeLibraries(groups, 'Original script')[0];
  const flowTarget = searchNativeLibraries(groups, 'Saved workflow')[0];
  assert.ok(scriptTarget); assert.ok(flowTarget);
  act(() => useViewerStore.getState().setScriptEditorContent('unfinished native script'));
  assert.equal(await openNativeLibraryArtifact(scriptTarget, null), 'unsaved');
  assert.equal(useViewerStore.getState().scriptEditorContent, 'unfinished native script');
  const originalFlow = useViewerStore.getState().flowDoc;
  assert.ok(originalFlow);
  act(() => useViewerStore.getState().setFlowDoc({ ...originalFlow, name: 'Unfinished native workflow' }));
  assert.equal(await openNativeLibraryArtifact(flowTarget, null), 'unsaved');
  assert.equal(useViewerStore.getState().flowDoc?.name, 'Unfinished native workflow');
  act(() => useViewerStore.getState().renameScript(script, 'Changed script'));
  assert.equal(await openNativeLibraryArtifact(scriptTarget, null), 'changed');
  act(() => useViewerStore.getState().deleteScript(script));
  assert.equal(await openNativeLibraryArtifact(scriptTarget, null), 'missing');
  assert.equal(useViewerStore.getState().flowDoc?.name, 'Unfinished native workflow');
  assert.equal(useViewerStore.getState().savedFlows.some(entry => entry.doc.id === flow), true);
});
