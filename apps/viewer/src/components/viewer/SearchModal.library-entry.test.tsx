/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { cleanup, render } from '@/test/render';
import { useViewerStore } from '@/store';
import { loadSavedScripts } from '@/lib/scripts/persistence';
import { loadSavedFlows } from '@/lib/flow/persistence';
import { SearchModal } from './SearchModal';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); localStorage.clear(); useViewerStore.setState(initial, true); });

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

test('#7235 existing entity search remains reachable without automatically running native libraries', () => {
  useViewerStore.setState({ models: new Map(), searchModalOpen: true });
  render(<SearchModal />);
  assert.ok([...document.querySelectorAll('[role="tab"]')].some(tab => tab.textContent === 'Search'));
  assert.equal(useViewerStore.getState().scriptExecutionState, 'idle');
  assert.equal(useViewerStore.getState().flowRunning, false);
});
