/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { installLayout } from '@/test/dom-layout';
installLayout();
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { cleanup, click, activate, type, waitFor } from '@/test/render';
import { fixtureModels } from '@/test/store-fixture';
import { seedSemanticModels } from '@/test/semantic-model-fixture';
import { mountDestinations, launchDestination, namedButton } from '@/test/palette-destinations';
import { MobilePanelSheet } from './MobilePanelSheet';
import { useSemanticSession } from '@/lib/semantic/session';
import { loadSavedScripts } from '@/lib/scripts/persistence';

const initial = useViewerStore.getState();
const semantic = useSemanticSession.getState();
const originalFetch = globalThis.fetch;
const code = '// Local workflow witness; never executed\nconsole.log("review only");';
let host: ReturnType<typeof mountDestinations> | undefined;
beforeEach(() => {
  setLocale('en'); localStorage.clear(); localStorage.setItem('ifc-lite-chat-panel-visible', 'false');
  globalThis.fetch = (() => Promise.reject(new Error('External network disabled in palette workflow witness'))) as typeof fetch;
  useViewerStore.setState({ ...fixtureModels(), ifcDataStore: null, isMobile: true, loading: false,
    rightPanelCollapsed: true, sidebarActivePanel: 'properties', floatingPanels: [], poppedOutIds: [],
    scriptPanelVisible: false, listPanelVisible: false, chatPanelVisible: false, savedScripts: [], activeScriptId: null,
    scriptEditorDirty: false, scriptDeleteConfirmId: null, scriptExecutionState: 'idle', chatToolReady: null });
  useViewerStore.getState().createScript('Palette portable query', code);
});
afterEach(async () => {
  cleanup(); mock.restoreAll(); await host?.dispose(); host = undefined; globalThis.fetch = originalFetch;
  useViewerStore.setState(initial, true); useSemanticSession.setState(semantic, true); localStorage.clear();
});
async function openScript() {
  host = mountDestinations(<MobilePanelSheet bottomInset={0} analysisExtension={null} />);
  await launchDestination('panel:script', 'script editor');
  await waitFor(() => !!document.querySelector('button[aria-label="Export saved script"]'), 'canonical Script editor body');
  assert.equal(document.querySelector('input[role="combobox"]'), null);
}
function chooseFile(text: string) {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Import script file"]'); assert.ok(input);
  act(() => {
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([text], 'local.ifc-script.json', { type: 'application/json' })] });
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

for (const loaded of [false, true]) {
  test(`#8947 ${loaded ? 'loaded' : 'unloaded'} palette Script exports saved code, recovers from invalid import and opens the imported copy`, async () => {
    if (loaded) await seedSemanticModels(1);
    const sequence = useViewerStore.getState().scriptRunSeq;
    await openScript();
    const offered: Blob[] = [];
    mock.method(URL, 'createObjectURL', (blob: Blob | MediaSource) => { assert.ok(blob instanceof Blob); offered.push(blob); return 'blob:palette-script'; });
    mock.method(HTMLAnchorElement.prototype, 'click', () => {});
    // A dirty editor must not silently replace the explicitly saved export.
    act(() => useViewerStore.getState().setScriptEditorContent('// unsaved next revision'));
    click(namedButton('Export saved script'));
    assert.equal(offered.length, 1);
    const portable = await offered[0].text();
    const decoded: unknown = JSON.parse(portable);
    assert.ok(decoded && typeof decoded === 'object' && 'script' in decoded);
    assert.deepEqual(loadSavedScripts().map(script => script.code), [code]);
    assert.ok(portable.includes('review only')); assert.ok(!portable.includes('unsaved next revision'));
    chooseFile('{invalid');
    await waitFor(() => /Script file is not valid JSON/.test(document.querySelector('output')?.textContent ?? ''), 'invalid import refusal visible');
    assert.equal(useViewerStore.getState().savedScripts.length, 1);
    chooseFile(portable);
    await waitFor(() => useViewerStore.getState().savedScripts.length === 2, 'valid import recovers');
    assert.equal(useViewerStore.getState().scriptEditorContent, '// unsaved next revision');
    const copy = useViewerStore.getState().savedScripts[1];
    assert.equal(copy.code, code); assert.notEqual(copy.id, useViewerStore.getState().activeScriptId);
    activate(namedButton('Select saved script'));
    await waitFor(() => document.querySelectorAll('[role="menuitem"]').length > 0, 'saved-script selector');
    const choices = [...document.querySelectorAll('[role="menuitem"]')].filter(row => row.textContent?.trim() === copy.name);
    assert.equal(choices.length, 2); click(choices[1]);
    assert.equal(useViewerStore.getState().activeScriptId, copy.id);
    assert.equal(useViewerStore.getState().scriptEditorContent, code);
    assert.equal(useViewerStore.getState().scriptRunSeq, sequence, 'import and navigation never execute scripts');
    assert.equal(useViewerStore.getState().scriptExecutionState, 'idle');
  });
}

test('#8947 palette Script promotion reaches capability review and cancels back to the naming draft without installation', async () => {
  await openScript();
  const sequence = useViewerStore.getState().scriptRunSeq;
  assert.ok(host); const installedBefore = await host.listInstalled();
  const promote = document.querySelector<HTMLButtonElement>('button[aria-label="Save this script as a persistent tool"]'); assert.ok(promote && !promote.disabled);
  click(promote);
  await waitFor(() => !!document.querySelector('#tool-name'), 'real promotion dialog');
  const name = document.querySelector<HTMLInputElement>('#tool-name'); assert.ok(name); type(name, 'Local review tool');
  const hotkey = document.querySelector<HTMLInputElement>('#tool-hotkey'); assert.ok(hotkey); type(hotkey, 'alt+shift+9');
  click(namedButton('Review & install'));
  await waitFor(() => document.querySelector('#tool-name') === null && !!document.querySelector('[role="dialog"]'), 'real capability review replaces naming');
  const review = document.querySelector('[role="dialog"]'); assert.ok(review);
  assert.match(review.textContent ?? '', /model.read/);
  click(namedButton('Cancel', review));
  await waitFor(() => !!document.querySelector('#tool-name'), 'review cancellation returns to naming');
  assert.equal(document.querySelector<HTMLInputElement>('#tool-name')?.value, 'Local review tool');
  assert.equal(document.querySelector<HTMLInputElement>('#tool-hotkey')?.value, 'alt+shift+9');
  click(namedButton('Cancel', document.querySelector('[role="dialog"]')!));
  assert.equal(document.querySelector('[role="dialog"]'), null);
  assert.equal(useViewerStore.getState().scriptEditorContent, code);
  assert.equal(useViewerStore.getState().scriptRunSeq, sequence);
  assert.ok(host); assert.deepEqual(await host.listInstalled(), installedBefore, 'cancel installs no tool');
});
