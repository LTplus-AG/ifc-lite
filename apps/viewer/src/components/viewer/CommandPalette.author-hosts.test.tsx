/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { createBimContext, type BimContext } from '@ifc-lite/sdk';
import { BimReactContext } from '@/sdk/BimProvider';
import { LocalBackend } from '@/sdk/local-backend';
import { IfcParser } from '@ifc-lite/parser';
import { setLocale } from '@/i18n';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { activate, advance, cleanup, click, press, render, type as typeInto, waitFor } from '@/test/render';
import { posthog } from '@/lib/analytics';
import { CommandPalette } from './CommandPalette';
import { PersistentToolHosts, usePersistentToolHosts } from './PersistentToolHosts';
import { ElementsTab } from './ribbon/tabs/ElementsTab';
import { AuthorTab } from './ribbon/tabs/AuthorTab';
import { ViewportHud } from '@/components/viewport-ui/hud/ViewportHud';
import { MergeLayersBanner } from './MergeLayersBanner';
import { GeometryModeBanner } from './GeometryModeBanner';
import { RECENT_KEY } from './commandPaletteSearch';

const original = useViewerStore.getState();
let bim: BimContext;
const step = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('author.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('0aaaaaaaaaaaaaaaaaaaaa',$,'Wall A',$,$,$,$,$,.STANDARD.);
ENDSEC;
END-ISO-10303-21;`;
beforeEach(async () => {
  setLocale('en'); localStorage.clear();
  const data = await new IfcParser().parseColumnar(new TextEncoder().encode(step).buffer, { disableWorkerScan: true });
  const model = fixtureModel('a'); model.ifcDataStore = data;
  useViewerStore.setState({ ...fixtureModels(model), collabRole: null, editEnabled: true, loading: false,
    mutationViews: new Map(), undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(),
    selectedEntityId: 1, selectedEntityIds: new Set(), referenceUndo: [], referenceRedo: [],
    modelPlacement: original.modelPlacement, geometryMode: 'exact', mergeLayers: false });
  bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
});
afterEach(() => { cleanup(); mock.restoreAll(); useViewerStore.setState(original); localStorage.clear(); });
function button(text: string) {
  const result = [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  assert.ok(result, text); return result;
}
function option(id: string) {
  const result = document.querySelector<HTMLButtonElement>(`[role="option"][data-command-id="${id}"]`);
  assert.ok(result, id); return result;
}
function Harness({ hosts = true }: { hosts?: boolean }) {
  const [open, setOpen] = useState(true);
  const [ribbon, setRibbon] = useState(false);
  const body = <>
    <button onClick={() => setOpen(true)}>Palette</button>
    <button onClick={() => setRibbon(r => !r)}>Ribbon</button>
    {ribbon && <AuthorTab />}
    <CommandPalette open={open} onOpenChange={setOpen} />
  </>;
  return <BimReactContext.Provider value={bim}>
    {hosts ? <PersistentToolHosts>{body}</PersistentToolHosts> : body}
  </BimReactContext.Provider>;
}
async function waitForAuthor(id: string) {
  if (id === 'author:bulk-properties') {
    await waitFor(() => !!document.querySelector('button[aria-label="Target source"]'), 'bulk editor Target source');
    await waitFor(() => [...document.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Construction stage preset'), 'bulk editor Construction stage preset');
  } else if (id === 'author:import-data') {
    await waitFor(() => !!document.querySelector('input[type="file"]'), 'data connector file input');
  }
}
async function launch(id: string) { click(option(id)); await advance(50); await waitForAuthor(id); }
function closeDialog() {
  const close = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b => b.textContent?.trim() === 'Close');
  if (close) click(close); else press(document.querySelector('[role="dialog"]')!, 'Escape');
}

for (const [id, title] of [['author:bulk-properties', 'Bulk Property Editor'], ['author:import-data', 'Import External Data']] as const) {
  test(`palette opens actual ${id} with the ribbon unmounted (#8947)`, async () => {
    useViewerStore.setState({ selectedEntityId: null, selectedEntityIds: new Set() });
    render(<Harness />); await advance(30); await launch(id);
    assert.equal(document.querySelector('[role="combobox"][placeholder="What do you need?"]'), null);
    assert.match(document.body.textContent ?? '', new RegExp(title, 'i'));
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1);
    if (id === 'author:import-data') assert.ok(document.querySelector('input[type="file"]'));
    else assert.ok(document.querySelector('button[aria-label="Target source"]'));
  });
}

test('bulk draft survives cancel, ribbon unmount and palette reopen (#8947)', async () => {
  render(<Harness />); await advance(30);
  // Open through the actual ribbon, then remove that entire tab while its host stays alive.
  press(document.querySelector('[role="combobox"]')!, 'Escape'); await advance(0);
  click(button('Ribbon'));
  click(document.querySelector('[data-command-id="author:bulk-properties"]')!); await waitForAuthor('author:bulk-properties');
  click(button('Construction stage preset')); await advance(0);
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Value"]'); assert.ok(input);
  typeInto(input, '7');
  click(button('Ribbon'));
  assert.equal(document.querySelector('input[placeholder="Value"]'), input);
  closeDialog(); await advance(0); click(button('Palette')); await advance(30);
  await launch('author:bulk-properties');
  assert.equal(document.querySelector<HTMLInputElement>('input[placeholder="Value"]')?.value, '7');
});

test('CSV upload and mapping draft survive close and reopen from palette (#8947)', async () => {
  render(<Harness />); await advance(30); await launch('author:import-data');
  const input = document.querySelector<HTMLInputElement>('input[type="file"]'); assert.ok(input);
  Object.defineProperty(input, 'files', { configurable: true, value: [new File(['GlobalId,Stage\n0aaaaaaaaaaaaaaaaaaaaa,3'], 'draft.csv', { type: 'text/csv' })] });
  act(() => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  await advance(100);
  assert.match(document.body.textContent ?? '', /draft.csv/);
  closeDialog(); await advance(0); click(button('Palette')); await advance(30); await launch('author:import-data');
  assert.match(document.body.textContent ?? '', /draft.csv/);
  assert.match(document.body.textContent ?? '', /Stage/);
});

test('role, unload and missing hosts refuse author commands without usage or execution events (#8947)', async () => {
  const events: string[] = [];
  mock.method(posthog, 'capture', (event: string) => { if (event === 'command_executed') events.push(event); });
  render(<Harness />); await advance(30);
  for (const state of [{ collabRole: 'viewer' as const }, { ...fixtureModels(), collabRole: null }]) {
    act(() => useViewerStore.setState(state));
    for (const id of ['author:bulk-properties', 'author:import-data']) {
      assert.equal(option(id).getAttribute('aria-disabled'), 'true'); click(option(id));
    }
  }
  assert.equal(localStorage.getItem(RECENT_KEY), null); assert.deepEqual(events, []);
  cleanup(); useViewerStore.setState(original); render(<Harness hosts={false} />); await advance(30);
  assert.equal(option('elements:class-filter').getAttribute('aria-disabled'), 'true');
});

test('class destination retains real geometry and layer switches without a selection (#8947)', async () => {
  useViewerStore.setState({ selectedEntityId: null, hasTypeGeometry: true });
  render(<Harness />); await advance(30); await launch('elements:class-filter');
  assert.ok(document.querySelector('[role="dialog"]'));
  const merge = document.querySelector<HTMLButtonElement>('[id$="-merge-layers-switch"]'); assert.ok(merge);
  click(merge); assert.equal(useViewerStore.getState().mergeLayers, true);
  assert.equal(useViewerStore.getState().mergeLayersPendingReload, true);
  const fast = document.querySelector<HTMLButtonElement>('[id$="-fast-geometry-switch"]'); assert.ok(fast);
  click(fast); assert.equal(useViewerStore.getState().geometryMode, 'fast');
  assert.equal(useViewerStore.getState().geometryModePendingReload, true);
  assert.ok(document.querySelector('[role="dialog"]'), 'toggles leave the real controls open');
  press(document.querySelector('[role="dialog"]')!, 'Escape'); await advance(0);
  let reloads = 0;
  render(<><ViewportHud /><MergeLayersBanner onReload={() => { reloads++; }} />
    <GeometryModeBanner onReload={() => { reloads++; }} /></>);
  await advance(0);
  const dismiss = document.querySelector<HTMLButtonElement>('button[aria-label="Dismiss reload reminder"]');
  assert.ok(dismiss); click(dismiss);
  assert.equal(useViewerStore.getState().mergeLayersPendingReload, false);
  click(button('Reload')); assert.equal(reloads, 1);
  assert.equal(useViewerStore.getState().geometryModePendingReload, true);
});

test('workspace undo and redo replay a real bulk edit and update palette availability (#8947)', async () => {
  render(<Harness />); await advance(30);
  assert.equal(option('author:undo').getAttribute('aria-disabled'), 'true');
  await launch('author:bulk-properties'); click(button('Construction stage preset')); await advance(0);
  const value = document.querySelector<HTMLInputElement>('input[placeholder="Value"]'); assert.ok(value); typeInto(value, '4');
  const apply = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('Apply to')); assert.ok(apply);
  click(apply); await advance(100);
  const stage = () => useViewerStore.getState().mutationViews.get('a')?.getPropertyValue(1, 'CESIUM', 'Stage');
  assert.equal(stage(), 4);
  closeDialog(); await advance(0); click(button('Palette')); await advance(30); await launch('author:undo');
  assert.equal(stage(), null);
  click(button('Palette')); await advance(30); await launch('author:redo'); assert.equal(stage(), 4);
});

test('a deferred author row refuses its retired owner while the palette remains mounted (#8947)', async () => {
  let captured: ReturnType<typeof usePersistentToolHosts> = {};
  let retire: () => void = () => { throw new Error('Owner not mounted'); };
  function Capture() { captured = usePersistentToolHosts(); return null; }
  function Owner() {
    const [mounted, setMounted] = useState(true); retire = () => setMounted(false);
    return mounted ? <PersistentToolHosts><Capture /></PersistentToolHosts> : null;
  }
  render(<BimReactContext.Provider value={bim}><Owner /></BimReactContext.Provider>);
  render(<BimReactContext.Provider value={bim}><CommandPalette open onOpenChange={() => {}} surfaceContext={captured} /></BimReactContext.Provider>); await advance(30);
  const input = document.querySelector('[role="combobox"]'); assert.ok(input);
  const events: string[] = [];
  mock.method(posthog, 'capture', (event: string) => { if (event === 'command_executed') events.push(event); });
  const frames: FrameRequestCallback[] = [];
  const originalFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  try {
    click(option('author:bulk-properties'));
    act(retire);
    assert.equal(document.querySelector('[role="combobox"]'), input, 'palette itself is still mounted');
    assert.equal(captured.toolHostIsCurrent?.(), false);
    act(() => frames.forEach(frame => frame(0)));
    assert.equal(localStorage.getItem(RECENT_KEY), null); assert.deepEqual(events, []);
    assert.equal(document.querySelector('input[placeholder="Value"]'), null);
  } finally { globalThis.requestAnimationFrame = originalFrame; }
});

test('class filter ribbon disclosure returns focus to its visible keyboard trigger (#8947)', async () => {
  render(<ElementsTab />);
  const trigger = document.querySelector<HTMLButtonElement>('[data-command-id="elements:class-filter"]'); assert.ok(trigger);
  activate(trigger); await advance(0);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  const menu = document.querySelector('[role="menu"]'); assert.ok(menu);
  press(menu, 'Escape'); await advance(0);
  assert.equal(document.activeElement, trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  activate(trigger); await advance(0); assert.ok(document.querySelector('[role="menu"]'));
});

test('class filter palette destination returns focus to the visible palette launcher (#8947)', async () => {
  render(<Harness />); await advance(30);
  press(document.querySelector('[role="combobox"]')!, 'Escape'); await advance(0);
  const launcher = button('Palette'); activate(launcher); await advance(30);
  await launch('elements:class-filter');
  const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog);
  assert.ok(dialog.querySelector('[role="switch"]'));
  press(dialog, 'Escape'); await advance(0);
  assert.equal(document.activeElement, launcher);
  activate(launcher); await advance(30); assert.ok(document.querySelector('[role="combobox"]'));
});

test('persistent bulk editor reconciles a removed model before querying and applying (#8947)', async () => {
  useViewerStore.setState({ selectedEntityId: null, selectedEntityIds: new Set() });
  render(<Harness />); await advance(30); await launch('author:bulk-properties');
  closeDialog(); await advance(0);
  const b = fixtureModel('b');
  b.ifcDataStore = await new IfcParser().parseColumnar(new TextEncoder().encode(step.replace('Wall A', 'Wall B')).buffer, { disableWorkerScan: true });
  act(() => useViewerStore.setState({ ...fixtureModels(b), selectedEntityId: null, selectedEntityIds: new Set() }));
  click(button('Palette')); await advance(30); await launch('author:bulk-properties');
  assert.ok([...document.querySelectorAll('[role="combobox"]')].some(p => p.textContent === 'b'));
  click(button('Construction stage preset')); await advance(0);
  const value = document.querySelector<HTMLInputElement>('input[placeholder="Value"]'); assert.ok(value); typeInto(value, '6');
  // The stage preset intentionally switches to Selection. With nothing selected
  // it must refuse; use the real source control to resume this Query scenario.
  const applyButton = () => [...document.querySelectorAll('button')].find(p => p.textContent?.includes('Apply to'));
  const source = document.querySelector<HTMLElement>('[role="combobox"][aria-label="Target source"]');
  assert.ok(source); assert.equal(source.textContent, 'Selection');
  assert.equal(applyButton()?.disabled, true);
  activate(source); await advance(0);
  const query = [...document.querySelectorAll('[role="option"]')].find(p => p.textContent === 'Query');
  assert.ok(query); click(query); await advance(0);
  assert.equal(source.textContent, 'Query');
  // Reopening first reconciles selectedModelId, then resolves B's query and clears computing.
  await waitFor(() => applyButton()?.disabled === false, 'B query resolves and enables Apply');
  const apply = applyButton(); assert.ok(apply && !apply.disabled);
  assert.match(apply.textContent ?? '', /Apply to 1 entit/);
  click(apply);
  await waitFor(() => useViewerStore.getState().getMutationView('b')?.getPropertyValue(1, 'CESIUM', 'Stage') === 6,
    'real bulk edit writes Stage 6 to parsed model B');
  assert.equal(useViewerStore.getState().getMutationView('b')?.getPropertyValue(1, 'CESIUM', 'Stage'), 6);
  assert.equal(useViewerStore.getState().getMutationView('a')?.getPropertyValue(1, 'CESIUM', 'Stage'), null);
});

for (const id of ['author:bulk-properties', 'author:import-data']) {
  for (const from of ['ribbon', 'ribbon-pointer', 'palette']) test(`#8962 ${id} returns focus to its ${from} launcher`, async () => {
    render(<Harness />); await advance(30);
    press(document.querySelector('[role="combobox"]')!, 'Escape'); await advance(0);
    let launcher: HTMLButtonElement;
    if (from.startsWith('ribbon')) {
      click(button('Ribbon'));
      const trigger = document.querySelector<HTMLButtonElement>(`[data-command-id="${id}"]`); assert.ok(trigger);
      launcher = trigger;
      if (from === 'ribbon-pointer') click(launcher); else activate(launcher);
      await waitForAuthor(id);
    } else {
      launcher = button('Palette'); activate(launcher); await advance(30); await launch(id);
    }
    closeDialog(); await advance(30);
    // Keep DOM identity failures bounded: inspecting Happy DOM's element graph
    // obscures the focus mismatch and can exhaust the test process (#8962).
    assert.ok(document.activeElement === launcher,
      `${id} via ${from}: expected launcher focus, got ${document.activeElement?.tagName} ${document.activeElement?.getAttribute('data-command-id') ?? ''}`);
    activate(launcher); await advance(30);
    if (from === 'palette') assert.ok(document.querySelector('[role="combobox"]'));
    else await waitForAuthor(id);
  });
}
