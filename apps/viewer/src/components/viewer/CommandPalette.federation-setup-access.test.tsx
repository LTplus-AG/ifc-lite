/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act, useState } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { computeSourceFingerprint } from '@ifc-lite/cache';
import { BimReactContext } from '@/sdk/BimProvider';
import { LocalBackend } from '@/sdk/local-backend';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';
import { getLocale, setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { posthog } from '@/lib/analytics';
import { Toaster } from '@/components/ui/toast';
import { ARCH, seedArtifactModels } from '@/test/artifact-models-fixture';
import { fixtureModels } from '@/test/store-fixture';
import { cleanup, click, press, render, type as typeInto, waitFor } from '@/test/render';
import { namedButton } from '@/test/palette-destinations';
import { parseFederationSetupFile } from '@/lib/federation/federationSetupFile';
import { CommandPalette } from './CommandPalette';
import { RECENT_KEY } from './commandPaletteSearch';
import { useFileCommands } from './toolbar/useFileCommands';

// #8947: a new parent/body join; the four #8566 restore/refusal cases stay intact.
// Real parsed SketchUp IFC metadata and real source Files, no geometry/load success
// claimed. Only browser publication and input activation are intercepted. Never Apply.
const initial = useViewerStore.getState();
const locale = getLocale();
let host: ExtensionHostService | undefined;
const originalCreateURL = URL.createObjectURL;
const originalRevokeURL = URL.revokeObjectURL;
const originalAnchorClick = HTMLAnchorElement.prototype.click;
const originalInputClick = HTMLInputElement.prototype.click;
let activating = false;
let blobs: Blob[];
let downloads: Array<{ filename: string; href: string }>;
let inputClicks: Array<{ input: HTMLInputElement; duringActivation: boolean }>;

beforeEach(() => {
  setLocale('en'); localStorage.clear();
  useViewerStore.setState({ ...initial, ...fixtureModels(), ifcDataStore: null,
    loading: false, error: null, collabRole: null, anchorModelIdOverride: null,
    modelTags: new Map(), modelTagAssignments: new Map(), georefMutations: new Map() });
  blobs = []; downloads = []; inputClicks = []; activating = false;
  URL.createObjectURL = blob => {
    assert.ok(blob instanceof Blob); blobs.push(blob);
    return `blob:palette-federation-${blobs.length}`;
  };
  URL.revokeObjectURL = () => undefined;
  HTMLAnchorElement.prototype.click = function () {
    downloads.push({ filename: this.download, href: this.href });
  };
  HTMLInputElement.prototype.click = function () {
    if (this.type === 'file') inputClicks.push({ input: this, duringActivation: activating });
    else originalInputClick.call(this);
  };
});
afterEach(async () => {
  for (const button of document.querySelectorAll('[data-toast-seq] button')) click(button);
  cleanup();
  try { await host?.dispose(); }
  finally {
    host = undefined; mock.restoreAll(); useViewerStore.setState(initial, true);
    setLocale(locale); localStorage.clear();
    URL.createObjectURL = originalCreateURL; URL.revokeObjectURL = originalRevokeURL;
    HTMLAnchorElement.prototype.click = originalAnchorClick;
    HTMLInputElement.prototype.click = originalInputClick;
  }
});
function FileHost() { return <>{useFileCommands().fileInputs}</>; }
function mount() {
  const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
  host = new ExtensionHostService({ sdk: bim });
  function Harness() {
    const [open, setOpen] = useState(false);
    return <BimReactContext.Provider value={bim}><ExtensionHostContext.Provider value={host!}>
      <FileHost />
      <button data-palette-launcher onClick={() => setOpen(true)}>Commands</button>
      <CommandPalette open={open} onOpenChange={setOpen} />
      <Toaster />
    </ExtensionHostContext.Provider></BimReactContext.Provider>;
  }
  render(<Harness />);
}
function required<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const node = root.querySelector<T>(selector); assert.ok(node, selector); return node;
}
function search(query: string, id: string) {
  click(required('[data-palette-launcher]'));
  const input = required<HTMLInputElement>('input[role="combobox"]');
  typeInto(input, query);
  return { input, row: required<HTMLElement>(`[role="option"][data-command-id="${id}"]`) };
}
function activateRow(id: string, query: string, keyboard: boolean) {
  const { input, row } = search(query, id);
  assert.notEqual(row.getAttribute('aria-disabled'), 'true');
  activating = true;
  try {
    if (keyboard) {
      act(() => row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
      assert.equal(row.getAttribute('aria-selected'), 'true');
      press(input, 'Enter');
    } else click(row);
  } finally { activating = false; }
}
async function selectFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}
function setupInput() {
  return required<HTMLInputElement>('input[type="file"][accept=".json,application/json"]');
}
async function reopen(saved: File, files: File[], keyboard: boolean) {
  const first = setupInput();
  const previous = inputClicks.length;
  activateRow('file:open-federation-setup', 'open federation setup', keyboard);
  // No await: this is the first picker inside the palette activation stack.
  assert.equal(inputClicks.length, previous + 1);
  assert.equal(inputClicks[previous].input, first);
  assert.equal(inputClicks[previous].duringActivation, true);
  assert.equal(document.querySelector('input[role="combobox"]'), null);
  assert.equal(first.isConnected, true, 'persistent host survives palette closure');
  await selectFiles(first, [saved]);
  await waitFor(() => inputClicks.length === previous + 2, 'real JSON parse requests source picker');
  const second = inputClicks[previous + 1].input;
  assert.notEqual(second, first);
  assert.equal(second.multiple, true);
  assert.equal(second.isConnected, true);
  // The second picker is async; no transient user-activation claim is made.
  assert.equal(inputClicks[previous + 1].duringActivation, false);
  await selectFiles(second, files);
  await waitFor(() => !!document.querySelector('[role="dialog"]'), 'real source matching opens review');
  const dialog = required('[role="dialog"]');
  assert.match(dialog.textContent ?? '', /Reopen federation setup/);
  return dialog;
}
async function cancel(dialog: Element) {
  click(namedButton('Cancel', dialog));
  await waitFor(() => !document.querySelector('[role="dialog"]'), 'review cancels');
}
async function seed(federated: boolean) {
  await seedArtifactModels({ federated });
  const files: File[] = [];
  const models = new Map(useViewerStore.getState().models);
  for (const [id, model] of models) {
    const bytes = readFileSync(new URL(`../../../public/samples/${model.name}`, import.meta.url));
    const file = new File([new Uint8Array(bytes)], model.name, { type: 'application/x-step' });
    files.push(file);
    models.set(id, { ...model, sourceFile: file, fileSize: file.size,
      visible: id === ARCH, collapsed: id !== ARCH });
  }
  const store = models.get(ARCH)?.ifcDataStore; assert.ok(store);
  assert.equal(store.entityIndex.byType.get('IFCWALL')?.length, 4, 'real parsed SketchUp fixture');
  useViewerStore.setState({ models, anchorModelIdOverride: ARCH,
    modelTags: new Map([['access', { id: 'access', name: 'Access review', color: '#123456' }]]),
    modelTagAssignments: new Map([[ARCH, new Set(['access'])]]) });
  return files;
}

for (const federated of [false, true]) {
  test(`#8947 palette save/open reaches real setup Blob and cancellable match review (${federated ? 'N' : '1'} model)`, async () => {
    const files = await seed(federated);
    const state = useViewerStore.getState();
    const models = state.models;
    const tags = state.modelTagAssignments;
    mount();
    activateRow('file:save-federation-setup', 'save federation setup', false);
    await waitFor(() => downloads.length === 1, 'real canonical download publication');
    assert.equal(blobs.length, 1);
    assert.equal(downloads[0].href, 'blob:palette-federation-1');
    assert.equal(downloads[0].filename, federated ? 'federation-setup-2-models.federation.json'
      : 'building-architecture.ifc.federation.json');
    assert.match(blobs[0].type, /^application\/json/);
    const text = await blobs[0].text();
    const parsed = parseFederationSetupFile(text); assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error(parsed.error);
    assert.equal(parsed.setup.slots.length, files.length);
    assert.deepEqual(parsed.setup.tags, [{ id: 'access', name: 'Access review', color: '#123456' }]);
    for (const [index, file] of files.entries()) {
      assert.deepEqual(parsed.setup.slots[index], {
        name: file.name, fileSize: file.size,
        fingerprintHex: computeSourceFingerprint(await file.arrayBuffer()).hex,
        visible: index === 0, collapsed: index !== 0, anchor: index === 0,
        tagIds: index === 0 ? ['access'] : [],
      });
    }
    assert.equal(document.querySelector('input[role="combobox"]'), null);
    const saved = new File([blobs[0]], downloads[0].filename, { type: blobs[0].type });
    let dialog = await reopen(saved, files, true);
    for (const file of files) {
      const label = [...dialog.querySelectorAll('span')].find(n => n.textContent === file.name);
      assert.ok(label, file.name);
      assert.match(label.parentElement?.textContent ?? '', /Matched/);
    }
    assert.equal(namedButton('Restore federation', dialog).disabled, false);
    await cancel(dialog);
    // Re-select the actual downloaded JSON; same-name changed bytes are visibly
    // mismatched, and an omitted second slot stays missing rather than restored.
    const changed = new File([files[0], '\n/* changed source */'], files[0].name);
    dialog = await reopen(saved, [changed], false);
    const firstLabel = [...dialog.querySelectorAll('span')].find(n => n.textContent === files[0].name);
    assert.ok(firstLabel);
    assert.match(firstLabel.parentElement?.textContent ?? '', /Same name, different file/);
    if (federated) {
      const missing = [...dialog.querySelectorAll('span')].find(n => n.textContent === files[1].name);
      assert.ok(missing); assert.match(missing.parentElement?.textContent ?? '', /Missing/);
    }
    await cancel(dialog);
    dialog = await reopen(saved, [new File(['unrelated'], 'unrelated.ifc')], true);
    assert.equal(namedButton('Restore federation', dialog).disabled, true, 'all missing cannot restore');
    assert.match(dialog.textContent ?? '', /Missing/);
    await cancel(dialog);
    assert.equal(useViewerStore.getState().models, models, 'review/cancel never restores or replaces models');
    assert.equal(useViewerStore.getState().modelTagAssignments, tags);
    assert.equal(useViewerStore.getState().loading, false);
    assert.equal(downloads.length, 1);
    assert.equal(blobs.length, 1);
  });
}

test('#8947 Save setup refuses live model loss for pointer and Enter without publication', async () => {
  await seed(false);
  const executions: string[] = [];
  mock.method(posthog, 'capture', (event: string) => { if (event === 'command_executed') executions.push(event); });
  mount();
  const { input, row } = search('save federation setup', 'file:save-federation-setup');
  assert.notEqual(row.getAttribute('aria-disabled'), 'true');
  act(() => useViewerStore.setState({ ...fixtureModels(), ifcDataStore: null }));
  assert.equal(row.getAttribute('aria-disabled'), 'true');
  click(row);
  act(() => row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
  press(input, 'Enter');
  // Flush the same deferred execution frames that would otherwise save.
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  assert.equal(downloads.length, 0); assert.equal(blobs.length, 0);
  assert.equal(localStorage.getItem(RECENT_KEY), null);
  assert.deepEqual(executions, []);
  assert.ok(document.querySelector('input[role="combobox"]'), 'refusal retains palette');
  assert.equal(useViewerStore.getState().models.size, 0);
  assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, 'only the palette remains, with no setup review');
  assert.equal(document.querySelector('[role="dialog"] input[role="combobox"]'), input);
});
