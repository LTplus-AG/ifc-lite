/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { cleanup, click, press, type, waitFor, advance } from '@/test/render';
import { fixtureModels } from '@/test/store-fixture';
import { seedSemanticModels } from '@/test/semantic-model-fixture';
import { mountDestinations, searchDestination, destinationOption, namedButton } from '@/test/palette-destinations';
import { MobilePanelSheet } from './MobilePanelSheet';
import { cancelAssistant, replaceEvidence, useAssistant } from '@/lib/assistant/conversation';
import { captureEvidence } from '@/lib/assistant/evidence';
import { setAssistantDraft } from '@/lib/assistant/composer-draft';
import { useAssistantPlacement } from '@/lib/assistant/placement';
import { useAssistantLibrary } from '@/lib/assistant/library';
import { useAssistantPreferences } from '@/lib/assistant/reuse/preferences';
import { useSemanticSession } from '@/lib/semantic/session';

const originalFetch = globalThis.fetch;
const initial = useViewerStore.getState();
const placement = useAssistantPlacement.getState();
const semantic = useSemanticSession.getState();
let host: ReturnType<typeof mountDestinations> | undefined;
beforeEach(() => {
  setLocale('en'); localStorage.clear();
  globalThis.fetch = (() => Promise.reject(new Error('External network disabled in palette workflow witness'))) as typeof fetch;
  useViewerStore.setState({ ...fixtureModels(), ifcDataStore: null, isMobile: true, loading: false,
    rightPanelCollapsed: true, sidebarActivePanel: 'properties', floatingPanels: [], poppedOutIds: [],
    scriptPanelVisible: false, listPanelVisible: false });
  useAssistant.setState({ snapshot: null, archived: null, messages: [], status: 'idle', error: null });
  setAssistantDraft('');
});
afterEach(async () => {
  cleanup(); globalThis.fetch = originalFetch; cancelAssistant(); setAssistantDraft(''); await host?.dispose(); host = undefined;
  useViewerStore.setState(initial, true); useAssistantPlacement.setState(placement, true);
  useSemanticSession.setState(semantic, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], status: 'idle', error: null });
  localStorage.clear();
});
async function openAssistant() {
  host = mountDestinations(<MobilePanelSheet bottomInset={0} analysisExtension={null} />);
  const search = searchDestination('assistant');
  // Exercise actual palette Enter activation, including its selected-row handling.
  act(() => destinationOption('panel:assistant').dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
  press(search, 'Enter');
  await waitFor(() => !!document.querySelector('#assistant-prompt'), 'canonical Assistant body');
  assert.equal(document.querySelector('input[role="combobox"]'), null);
}
function section(label: string) {
  const node = document.querySelector<HTMLElement>(`section[aria-label="${label}"]`);
  assert.ok(node, label); return node;
}

test('#8947 unloaded palette Assistant reaches saved conversations, recipes and no-project preferences', async () => {
  await openAssistant();
  click(namedButton('Saved conversations'));
  const library = section('Saved conversations');
  assert.equal(namedButton('Save conversation', library).disabled, true, 'no captured evidence cannot be saved');
  const name = library.querySelector<HTMLInputElement>('input'); assert.ok(name);
  type(name, 'Unsent library name'); press(name, 'Escape');
  assert.equal(document.querySelector('section[aria-label="Saved conversations"]'), null);
  click(namedButton('Task recipes'));
  await waitFor(() => !!document.querySelector('section[aria-label="Task recipes"]'), 'real recipe library');
  const recipes = section('Task recipes');
  const recipeFile = recipes.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(recipeFile);
  act(() => {
    Object.defineProperty(recipeFile, 'files', { configurable: true, value: [new File(['{invalid'], 'local.recipes.json', { type: 'application/json' })] });
    recipeFile.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
  await waitFor(() => !!recipes.querySelector('[role="alert"]'), 'invalid recipe file visibly refused');
  assert.ok(recipes.querySelectorAll('li').length > 0, 'curated child paths are visible without a model');
  click(namedButton('Task recipes'));
  assert.equal(document.querySelector('section[aria-label="Task recipes"]'), null);
  click(namedButton('Project preferences'));
  await waitFor(() => !!document.querySelector('section[aria-label="Project preferences"]'), 'preferences body');
  assert.match(section('Project preferences').textContent ?? '', /Load a model to save preferences/);
  assert.equal(section('Project preferences').querySelector('textarea'), null);
  assert.equal(document.querySelector<HTMLTextAreaElement>('#assistant-prompt')?.disabled, true);
});

test('#8947 loaded palette Assistant saves a captured conversation and changes then resets project preferences', async () => {
  await seedSemanticModels(1);
  // Durable project identity is fixture metadata, independent of the parsed IFC's display name.
  useViewerStore.setState({ models: new Map([...useViewerStore.getState().models].map(([id, model]) =>
    [id, { ...model, sourceFingerprint: 'palette-assistant-pilot-v1' }])) });
  replaceEvidence(captureEvidence('semantic'));
  await openAssistant();
  const prompt = document.querySelector<HTMLTextAreaElement>('#assistant-prompt'); assert.ok(prompt && !prompt.disabled);
  type(prompt, 'Keep this unsent question');
  click(namedButton('Saved conversations'));
  type(section('Saved conversations').querySelector('input')!, 'Linked records review');
  click(namedButton('Save conversation', section('Saved conversations')));
  await waitFor(() => useAssistantLibrary.getState().entries.some(entry => entry.name === 'Linked records review'), 'conversation persisted');
  assert.ok(namedButton('Linked records review', section('Saved conversations')));
  click(namedButton('Project preferences'));
  await waitFor(() => !!document.querySelector('section[aria-label="Project preferences"] textarea'), 'scoped preferences');
  type(section('Project preferences').querySelector('textarea')!, 'Cite the reviewed records.');
  click(namedButton('Save preferences', section('Project preferences')));
  await waitFor(() => /Preferences saved/.test(section('Project preferences').textContent ?? ''), 'preferences committed');
  assert.equal(useAssistantPreferences.getState().entries[0]?.houseRules, 'Cite the reviewed records.');
  const reset = [...section('Project preferences').querySelectorAll('button')].find(b => b.textContent?.trim() === 'Remove preferences');
  assert.ok(reset); click(reset);
  await waitFor(() => useAssistantPreferences.getState().entries.length === 0, 'project preferences reset');
  await advance(0);
  assert.equal(section('Project preferences').querySelector('textarea')?.value, '');
  assert.equal(prompt.value, 'Keep this unsent question', 'child workflows preserve the composer');
});
