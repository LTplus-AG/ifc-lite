/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { act, useState } from 'react';
import { BimReactContext } from '@/sdk/BimProvider';
import { CommandPalette } from '@/components/viewer/CommandPalette';
import { type as typeInto } from '@/test/render';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { cleanup, render, click, activate, press, advance, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { Toaster } from '@/components/ui/toast';
import { getLocale, setLocale } from '@/i18n';
import type { Command } from '@/components/viewer/commandPaletteSearch';
import { PaletteCommandTestHost } from '@/components/viewer/palette-extension-command.test-support';
import { manifestToContributions } from '../../../../../packages/extensions/src/host/loader';
import type { WidgetNode } from '../../../../../packages/extensions/src/widget/schema';
import { useExtensionDockDestinations } from './useExtensionDockDestinations';

const original = useViewerStore.getState();
const originalLocale = getLocale();
const hosts: PaletteCommandTestHost[] = [];
function createHost() { const host = new PaletteCommandTestHost(); hosts.push(host); return host; }
beforeEach(() => { setLocale('en'); useViewerStore.setState({ ...fixtureModels(), selectedEntityIds: new Set() }); });
afterEach(async () => {
  for (const dismiss of document.querySelectorAll('[data-toast-seq] button')) click(dismiss);
  cleanup();
  await advance(0); // Drain Radix close-autofocus timers before restoring shared state.
  for (const host of hosts.splice(0)) await host.dispose();
  setLocale(originalLocale); useViewerStore.setState(original);
});
const settle = async () => { await act(async () => { await new Promise(resolve => setImmediate(resolve)); }); };
let rows: Command[] = [];
function Harness() {
  const destinations = useExtensionDockDestinations(); rows = destinations.commands;
  return <>{rows.map(row => <button key={row.id} type="button" onClick={row.action}>{row.detail}</button>)}{destinations.dialog}<Toaster /></>;
}
function add(host: PaletteCommandTestHost, owner: string, when?: string, invalid = false) {
  if (!host.bundles.has(owner)) host.add(owner);
  const bundle = host.bundles.get(owner)!;
  const handler = 'function run(ctx) { ctx.bim.record(ctx.args); }';
  bundle.files.set('run.js', { path: 'run.js', text: handler, bytes: new TextEncoder().encode(handler) });
  const validWidget = {
    type: 'Stack', direction: 'vertical', children: [{ type: 'Text', text: `Body ${owner}` },
      { type: 'Button', label: 'Execute widget', command: 'paint', args: { groupBy: 'storey', limit: 3 } }],
  } satisfies WidgetNode;
  const widget = JSON.stringify(invalid ? { type: 'Bogus' } : validWidget);
  bundle.files.set('widget.json', { path: 'widget.json', text: widget, bytes: new TextEncoder().encode(widget) });
  bundle.manifest.contributes = { ...bundle.manifest.contributes, dock: [
    { id: 'shared', slot: 'dock.left', title: 'Inspector', widget: 'widget.json', when },
    { id: 'shared', slot: 'dock.right', title: 'Inspector', widget: 'widget.json', when },
    { id: 'shared', slot: 'dock.bottom', title: 'Inspector', widget: 'widget.json', when },
  ] };
  host.slotRegistry.unregister(owner);
  host.slotRegistry.register(owner, manifestToContributions(owner, bundle.manifest.contributes));
  host.loader.getBundle = id => host.bundles.get(id);
}
function button(text: string) {
  const result = [...document.querySelectorAll('button')].find(el => el.textContent === text);
  assert.ok(result, text); return result;
}

test('#8947 actual widgets in all dock slots open by keyboard, execute owner args, close and reopen without desktop hosts', async () => {
  const host = createHost(); add(host, 'alpha'); add(host, 'beta');
  render(<ExtensionHostContext.Provider value={host}><Harness /></ExtensionHostContext.Provider>);
  assert.equal(new Set(rows.map(row => row.id)).size, 6);
  for (const slot of ['dock.left', 'dock.right', 'dock.bottom']) {
    const launcher = button(`beta · ${slot}`);
    activate(launcher); await settle();
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Body beta/);
    activate(button('Execute widget')); await settle();
    assert.equal(host.executions.at(-1), 'beta');
    assert.deepEqual(host.commandArgs.at(-1), { groupBy: 'storey', limit: 3 });
    press(document.activeElement ?? document.body, 'Escape');
    await waitFor(() => !document.querySelector('[role="dialog"]') && document.activeElement === launcher,
      'Escape closes the contributed tool and restores its original launcher');
    // Preserve identity without serializing a cyclic DOM graph on failure.
    assert.ok(document.activeElement === launcher, 'focus returns to the original dock launcher');
    activate(launcher); await settle();
    click(button('Close')); await settle();
  }
});

test('#8947 when stays discoverable, changes live, and a replaced slot cannot keep its widget or run captured row', async () => {
  const host = createHost(); add(host, 'alpha', 'model.loaded && selection.count > 0');
  render(<ExtensionHostContext.Provider value={host}><Harness /></ExtensionHostContext.Provider>);
  assert.equal(rows[0].checkAvailability?.().status, 'disabled');
  act(() => useViewerStore.setState(fixtureModels(fixtureModel('m'))));
  assert.equal(rows[0].checkAvailability?.().status, 'disabled');
  act(() => useViewerStore.setState({ selectedEntityIds: new Set([1]) }));
  assert.equal(rows[0].checkAvailability?.().status, 'available');
  const captured = rows[0];
  click(button('alpha · dock.left · model.loaded && selection.count > 0')); await settle();
  act(() => useViewerStore.setState({ selectedEntityIds: new Set() })); await settle();
  assert.ok(document.querySelector('[role="dialog"] [role="alert"]'));
  act(() => useViewerStore.setState({ selectedEntityIds: new Set([1]) })); await settle();
  assert.ok(button('Execute widget'));
  act(() => host.slotRegistry.unregister('alpha'));
  assert.equal(captured.checkAvailability?.().status, 'disabled');
  act(() => add(host, 'alpha')); await settle();
  assert.ok(document.querySelector('[role="dialog"] [role="alert"]'));
  assert.equal(captured.checkAvailability?.().status, 'disabled');
  act(() => captured.action()); await settle();
  assert.deepEqual(host.executions, []);
});

test('#8947 invalid widget has visible error, and closing/reopening after repair recovers; provider replacement retires open tool', async () => {
  const host = createHost(); add(host, 'alpha', undefined, true);
  const replacement = createHost(); add(replacement, 'alpha');
  let changeHost: (() => void) | undefined;
  function Switch() {
    const [current, setCurrent] = useState(host); changeHost = () => setCurrent(replacement);
    return <ExtensionHostContext.Provider value={current}><Harness /></ExtensionHostContext.Provider>;
  }
  render(<Switch />);
  click(button('alpha · dock.left')); await settle();
  await waitFor(() => /Widget/.test(document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? ''),
    'invalid widget finishes loading and displays its real validation error');
  assert.match(document.querySelector('[role="dialog"] [role="alert"]')?.textContent ?? '', /Widget/);
  click(button('Close')); await settle();
  act(() => add(host, 'alpha')); await settle();
  click(button('alpha · dock.left')); await settle();
  assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Body alpha/);
  act(() => changeHost?.()); await settle();
  assert.ok(document.querySelector('[role="dialog"] [role="alert"]'));
});

// Exercise the actual palette keyboard/deferred-close boundary, not just the hook.
test('#8947 palette Enter opens the real contributed widget after its own popup closes', async () => {
  const host = createHost(); add(host, 'alpha');
  function Palette() {
    const [open, setOpen] = useState(true);
    return <CommandPalette open={open} onOpenChange={setOpen} />;
  }
  render(<BimReactContext.Provider value={host.sdk}><ExtensionHostContext.Provider value={host}>
    <Palette />
  </ExtensionHostContext.Provider></BimReactContext.Provider>);
  typeInto(document.querySelector<HTMLInputElement>('[role="combobox"]')!, 'Inspector');
  const previous = globalThis.requestAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = cb => { frames.push(cb); return frames.length; };
  try {
    press(document.querySelector('[role="combobox"]')!, 'Enter');
    act(() => { for (const frame of frames.splice(0)) frame(0); });
    await settle();
    assert.equal(Boolean(document.querySelector('[role="combobox"]')), false);
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Body alpha/);
    activate(button('Execute widget')); await settle();
    assert.deepEqual(host.commandArgs, [{ groupBy: 'storey', limit: 3 }]);
  } finally { globalThis.requestAnimationFrame = previous; }
});

test('#8947 actual widget command failures reach the visible error path', async () => {
  const host = createHost(); add(host, 'alpha');
  host.failure = new Error('Widget execution denied');
  render(<ExtensionHostContext.Provider value={host}><Harness /></ExtensionHostContext.Provider>);
  activate(button('alpha · dock.left')); await settle();
  activate(button('Execute widget')); await settle();
  assert.match(document.body.textContent ?? '', /Widget execution denied/);
  assert.deepEqual(host.executions, []);
});
