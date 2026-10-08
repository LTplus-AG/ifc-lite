/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseIDS } from '@ifc-lite/ids';
import { createBimContext } from '@ifc-lite/sdk';
import { act, useState } from 'react';
import { ExtensionHostService } from '@/services/extensions/host';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { NativeLibrarySearch } from './libraries/NativeLibrarySearch';
import { setValidationSourceChoice, useValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { cleanup, activate, click, render, type, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { loadSavedScripts } from '@/lib/scripts/persistence';
import { loadSavedFlows } from '@/lib/flow/persistence';
import { SearchModal } from './SearchModal';
import { nativeLibraryCatalogue, searchNativeLibraries } from '@/lib/libraries/native-catalogue';
import { openNativeLibraryArtifact } from '@/lib/libraries/open-native-artifact';
import { useLibraryFocus } from '@/lib/libraries/library-focus';

const initial = useViewerStore.getState();
afterEach(() => { mock.restoreAll(); setValidationSourceChoice(null); cleanup(); localStorage.clear(); useLibraryFocus.setState({ target: null }); useViewerStore.setState(initial, true); });

test('#7235 keyboard library search spans native persisted scripts/Flows and opens the exact script without execution', async () => {
  useViewerStore.setState({ models: new Map(), savedScripts: [], savedFlows: [], searchModalOpen: true, scriptEditorDirty: false });
  const script = useViewerStore.getState().createScript('Coordination script', 'bim.query.all("IfcWall")');
  const flow = useViewerStore.getState().createFlow('Coordination workflow');
  assert.ok(loadSavedScripts().some(entry => entry.id === script));
  assert.ok(loadSavedFlows().some(entry => entry.doc.id === flow));
  render(<SearchModal />);
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(item => item.textContent === 'Libraries');
  assert.ok(tab); activate(tab);
  await waitFor(() => Boolean(document.querySelector('input[aria-label="Search saved artifact names and types"]')), 'native Libraries tab');
  type(document.querySelector('input[aria-label="Search saved artifact names and types"]') as HTMLInputElement, 'Coordination');
  const rows = document.querySelector('ul[aria-label="Saved artifacts"]');
  assert.ok(rows);
  assert.match(rows.textContent ?? '', /Coordination script/);
  assert.match(rows.textContent ?? '', /Coordination workflow/);
  const open = [...rows.querySelectorAll('button')].find(button => button.textContent === 'Coordination script');
  assert.ok(open); activate(open);
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


test('#7235 unreadable native Flow startup storage is session knowledge, not a confirmed empty library', () => {
  mock.method(localStorage, 'getItem', () => { throw new DOMException('storage disabled', 'SecurityError'); });
  const loaded = loadSavedFlows();
  assert.deepEqual(loaded, [], 'actual native startup fallback');
  useViewerStore.setState({ savedFlows: loaded, flowStorageError: null });
  const group = nativeLibraryCatalogue(useViewerStore.getState(), { phase: 'unavailable', entries: [] })
    .find(entry => entry.family === 'flows');
  assert.equal(group?.phase, 'session', 'unknown read status must not certify durable emptiness');
});

const idsXml = readFileSync(new URL('../../../../../packages/ids/src/__corpus__/ifctester-parity-6117/empty-required.ids', import.meta.url), 'utf8');
function savedCheck() {
  const state = useViewerStore.getState();
  assert.equal(state.addValidationDefinition({ kind: 'ids', xml: idsXml, document: parseIDS(idsXml) }), true);
  const id = useViewerStore.getState().validationDefinitions.active.ids;
  assert.ok(id);
  const target = nativeLibraryCatalogue(useViewerStore.getState(), { phase: 'unavailable', entries: [] })
    .flatMap(group => group.rows).find(row => row.kind === 'check' && row.id === id);
  assert.ok(target);
  return target;
}

test('#7235 actual pending IDS audit cannot reopen validation after the native source choice changes', async () => {
  const target = savedCheck();
  const opening = openNativeLibraryArtifact(target, null);
  assert.equal(useViewerStore.getState().idsAuditing, true, 'real native audit is pending');
  setValidationSourceChoice('manual');
  assert.equal(await opening, 'changed');
  assert.equal(useValidationSourceChoice.getState().choice, 'manual');
  assert.equal(useLibraryFocus.getState().target, null);
});

test('#7235 same-id native IDS replacement during audit cannot focus the superseded check', async () => {
  const target = savedCheck();
  const opening = openNativeLibraryArtifact(target, null);
  assert.equal(useViewerStore.getState().idsAuditing, true);
  const replacement = idsXml.replace('An empty IfcLabel', 'Replacement native document');
  assert.equal(useViewerStore.getState().addValidationDefinition({ kind: 'ids', xml: replacement,
    document: parseIDS(replacement) }, target.id), true);
  assert.equal(await opening, 'changed');
  assert.equal(useLibraryFocus.getState().target, null);
  assert.match(useViewerStore.getState().idsDocument?.info.title ?? '', /Replacement native document/);
});

function nativeHost() {
  return new ExtensionHostService({ sdk: createBimContext({ transport: {
    send: () => Promise.reject(new Error('opening profiles must not execute SDK calls')),
    subscribe: () => () => {}, close: () => {},
  } }) });
}

test('#7235 stable native profile open focuses management without activating the saved profile', async () => {
  const host = nativeHost();
  const original = await host.flavors.resetToDefaults();
  await host.flavors.put({ ...original, id: 'native-other', name: 'Other coordination profile' });
  const entries = await host.flavors.list();
  const target = nativeLibraryCatalogue(useViewerStore.getState(), { phase: 'ready', entries, owner: host })
    .flatMap(group => group.rows).find(row => row.id === 'native-other');
  assert.ok(target);
  assert.equal(await openNativeLibraryArtifact(target, host), 'opened');
  assert.equal((await host.flavors.getActive())?.id, original.id);
  assert.equal(useViewerStore.getState().flavorDialogRequested, true);
  assert.deepEqual(useLibraryFocus.getState().target, { kind: 'profile', id: 'native-other' });
});

test('#7235 mounted profile read cannot navigate through an old host after provider replacement', async () => {
  const host = nativeHost();
  const profile = await host.flavors.resetToDefaults();
  let replaceHost: (() => void) | undefined;
  let opened = 0;
  function HostOwner() {
    const [current, setCurrent] = useState<ExtensionHostService | null>(host);
    replaceHost = () => setCurrent(nativeHost());
    return <ExtensionHostContext.Provider value={current}>
      <NativeLibrarySearch onOpened={() => { opened++; }} />
    </ExtensionHostContext.Provider>;
  }
  const ui = render(<HostOwner />);
  await waitFor(() => [...ui.querySelectorAll('button')].some(button => button.textContent === profile.name), 'native stored profile listed');
  const read = host.flavors.list.bind(host.flavors);
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  mock.method(host.flavors, 'list', async () => { const rows = await read(); entered = true; await pending; return rows; });
  const button = [...ui.querySelectorAll('button')].find(item => item.textContent === profile.name);
  assert.ok(button); click(button);
  await waitFor(() => entered, 'actual native profile read pending');
  assert.ok(replaceHost); act(replaceHost);
  assert.ok(release); await act(async () => { release(); await pending; });
  await waitFor(() => !ui.querySelector('button:disabled'), 'superseded open released');
  assert.equal(opened, 0);
  assert.equal(useLibraryFocus.getState().target, null);
  assert.equal(useViewerStore.getState().flavorDialogRequested, initial.flavorDialogRequested);
});
