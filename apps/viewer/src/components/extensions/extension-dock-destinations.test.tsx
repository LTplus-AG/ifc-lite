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
import { PaletteCommandTestHost } from '@/components/viewer/__fixtures__/palette-extension-command';
import { manifestToContributions } from '../../../../../packages/extensions/src/host/loader';
import type { DockContribution } from '@ifc-lite/extensions';
import { ExtensionDockBody } from './ExtensionDockBody';
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
    activate(launcher);
    await waitFor(() => /Body beta/.test(document.querySelector('[role="dialog"]')?.textContent ?? ''),
      'the deferred widget renderer loads the real contributed body');
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

// #8947 / review4522359363: hold activation inside the real canonical runner,
// not a replacement dispatch. Only storage/sandbox boundaries are fixtures.
for (const retirement of ['provider', 'contribution', 'unmount', 'provider-roundtrip', 'remount', 'none'] as const) {
  test(`#8947 dock ${retirement} during canonical activation refuses stale execution and keeps fresh buttons usable`, async () => {
    const first = createHost(); add(first, 'alpha');
    const second = createHost(); add(second, 'alpha');
    const slot = (host: PaletteCommandTestHost) => host.slotRegistry.getAll<DockContribution>('dock.left')[0];
    let release!: () => void;
    first.activationWait = new Promise<void>(resolve => { release = resolve; });
    let changeHost!: (host: PaletteCommandTestHost) => void;
    let changeSlot!: (contribution: ReturnType<typeof slot>) => void;
    let show!: (shown: boolean) => void;
    let allowed = false;
    let beforeCalls = 0;
    function Surface() {
      const [host, setHost] = useState(first); changeHost = setHost;
      const [contribution, setContribution] = useState(slot(first)); changeSlot = setContribution;
      const [shown, setShown] = useState(true); show = setShown;
      return <ExtensionHostContext.Provider value={host}>
        {shown && <ExtensionDockBody contribution={contribution} beforeCommand={() => { beforeCalls++; return allowed; }} />}
        <Toaster />
      </ExtensionHostContext.Provider>;
    }
    render(<Surface />);
    try {
      await waitFor(() => [...document.querySelectorAll('button')].some(el => el.textContent === 'Execute widget'), 'real dock widget loads');
      activate(button('Execute widget')); await settle();
      assert.equal(beforeCalls, 1);
      assert.deepEqual(first.activations, [], 'beforeCommand refusal never activates');
      allowed = true;
      activate(button('Execute widget'));
      await waitFor(() => first.activations.length === 1, 'canonical command reaches held activation');
      assert.deepEqual(first.events, []);
      assert.deepEqual(first.executions, []);
      if (retirement === 'provider' || retirement === 'provider-roundtrip') act(() => changeHost(second));
      if (retirement === 'provider-roundtrip') act(() => changeHost(first));
      if (retirement === 'contribution') act(() => add(first, 'alpha'));
      if (retirement === 'unmount' || retirement === 'remount') act(() => show(false));
      if (retirement === 'remount') act(() => show(true));
      release();
      if (retirement === 'none') await waitFor(() => first.executions.length === 1, 'current dock command executes');
      else await waitFor(() => /provider or contribution changed/.test(document.body.textContent ?? ''), 'retired command reports visible refusal');
      assert.equal(beforeCalls, 2, 'async freshness checks do not repeat beforeCommand side effects');
      assert.deepEqual(first.activations, ['alpha'], 'retirement never retries activation');
      assert.deepEqual(first.deactivations, []);
      assert.deepEqual(first.events, retirement === 'none' ? ['onCommand:paint'] : []);
      assert.deepEqual(first.executions, retirement === 'none' ? ['alpha'] : []);
      assert.deepEqual(first.commandArgs, retirement === 'none' ? [{ groupBy: 'storey', limit: 3 }] : []);
      assert.deepEqual(second.executions, []);
      if (retirement !== 'none') {
        first.activationWait = null;
        const fresh = retirement === 'provider' ? second : first;
        act(() => { changeHost(fresh); changeSlot(slot(fresh)); show(true); });
        await waitFor(() => [...document.querySelectorAll('button')].some(el => el.textContent === 'Execute widget'), 'fresh dock widget is usable');
        activate(button('Execute widget'));
        await waitFor(() => fresh.executions.length === 1, 'fresh command executes once');
        assert.deepEqual(fresh.events, ['onCommand:paint']);
        assert.deepEqual(fresh.commandArgs, [{ groupBy: 'storey', limit: 3 }]);
        assert.equal(beforeCalls, 3);
      }
    } finally { release(); await settle(); }
  });
}
