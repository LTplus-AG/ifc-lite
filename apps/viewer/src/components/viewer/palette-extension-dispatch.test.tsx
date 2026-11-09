/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { act, useState } from 'react';
import { BimReactContext } from '@/sdk/BimProvider';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionToolbarSlot } from '@/components/extensions/ExtensionToolbarSlot';
import { ExtensionKeyboardBindings } from '@/components/extensions/ExtensionKeyboardBindings';
import { Toaster } from '@/components/ui/toast';
import { setLocale } from '@/i18n';
import { posthog } from '@/lib/analytics';
import { useViewerStore } from '@/store';
import { cleanup, click, render, type as typeInto } from '@/test/render';
import { fixtureModels } from '@/test/store-fixture';
import { CommandPalette } from './CommandPalette';
import { RECENT_KEY } from './commandPaletteSearch';
import { PaletteCommandTestHost } from './__fixtures__/palette-extension-command';

const original = useViewerStore.getState();
beforeEach(() => {
  setLocale('en'); localStorage.clear();
  useViewerStore.setState({ ...fixtureModels(), selectedEntityIds: new Set(), loading: false, collabRole: null });
});
afterEach(() => {
  cleanup(); mock.restoreAll(); localStorage.clear(); useViewerStore.setState(original);
});
const settle = async () => { await act(async () => { await new Promise(resolve => setImmediate(resolve)); }); };
function row(owner: string) {
  const options = [...document.querySelectorAll<HTMLButtonElement>('[data-runtime-command-id]')]
    .filter(el => el.textContent?.includes('Check model') && el.textContent.includes(owner));
  assert.equal(options.length, 1, `one discoverable same-title command for owner ${owner}`);
  return options[0];
}
function palette(host: PaletteCommandTestHost) {
  render(<BimReactContext.Provider value={host.sdk}><ExtensionHostContext.Provider value={host}>
    <CommandPalette open onOpenChange={() => {}} />
    <Toaster />
  </ExtensionHostContext.Provider></BimReactContext.Provider>);
  typeInto(document.querySelector<HTMLInputElement>('[role="combobox"]')!, 'Check model');
}

test('#8947 mounted palette chooses the second same-title owner and runs once', async () => {
  const host = new PaletteCommandTestHost(); host.add('alpha'); host.add('beta');
  palette(host);
  assert.match(row('alpha').textContent ?? '', /alpha/);
  assert.match(row('beta').textContent ?? '', /beta/);
  const previous = globalThis.requestAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = cb => { frames.push(cb); return frames.length; };
  try {
    const selected = row('beta');
    const selectedId = selected.dataset.runtimeCommandId;
    assert.ok(selectedId);
    assert.notEqual(selectedId, row('alpha').dataset.runtimeCommandId);
    click(selected);
    act(() => { for (const cb of frames.splice(0)) cb(0); });
    await settle();
    assert.deepEqual(host.executions, ['beta']);
    assert.deepEqual(host.activations, ['beta']);
    assert.deepEqual(host.events, ['onCommand:paint']);
    assert.equal(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')[0], selectedId);
  } finally { globalThis.requestAnimationFrame = previous; }
});

for (const replace of [false, true]) test(`#8947 mounted palette refuses ${replace ? 'replacement' : 'unregistration'} before deferred usage/events`, async () => {
  const host = new PaletteCommandTestHost(); host.add('alpha'); palette(host);
  const events: string[] = [];
  mock.method(posthog, 'capture', (event: string) => { if (event === 'command_executed') events.push(event); });
  const previous = globalThis.requestAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = cb => { frames.push(cb); return frames.length; };
  try {
    click(row('alpha'));
    act(() => { host.slotRegistry.unregister('alpha'); if (replace) host.add('alpha'); });
    act(() => { for (const cb of frames.splice(0)) cb(0); });
    await settle();
    assert.deepEqual(host.executions, []);
    assert.deepEqual(host.activations, []);
    assert.deepEqual(host.events, []);
    assert.deepEqual(events, []);
    assert.equal(localStorage.getItem(RECENT_KEY), null);
  } finally { globalThis.requestAnimationFrame = previous; }
});

test('#8947 mounted palette surfaces canonical asynchronous errors', async () => {
  const host = new PaletteCommandTestHost(); host.add('alpha'); host.failure = new Error('Fixture grant revoked');
  palette(host);
  const previous = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = cb => { cb(0); return 1; };
  try { click(row('alpha')); await settle(); }
  finally { globalThis.requestAnimationFrame = previous; }
  assert.match(document.body.textContent ?? '', /Fixture grant revoked/);
  assert.deepEqual(host.activations, ['alpha']);
  assert.deepEqual(host.executions, []);
});

for (const removed of [false, true]) test(`#8947 deferred command rejects a ${removed ? 'removed' : 'replaced'} provider with old slots intact`, async () => {
  const first = new PaletteCommandTestHost(); first.add('alpha');
  const second = new PaletteCommandTestHost(); second.add('alpha');
  let changeHost: (host: PaletteCommandTestHost | null) => void = () => { throw new Error('Harness not mounted'); };
  function Harness() {
    const [host, setHost] = useState<PaletteCommandTestHost | null>(first);
    changeHost = setHost;
    return <BimReactContext.Provider value={first.sdk}><ExtensionHostContext.Provider value={host}>
      <CommandPalette open onOpenChange={() => {}} />
    </ExtensionHostContext.Provider></BimReactContext.Provider>;
  }
  render(<Harness />);
  typeInto(document.querySelector<HTMLInputElement>('[role="combobox"]')!, 'Check model');
  const events: string[] = [];
  mock.method(posthog, 'capture', (event: string) => { if (event === 'command_executed') events.push(event); });
  const previous = globalThis.requestAnimationFrame;
  const frames: FrameRequestCallback[] = [];
  globalThis.requestAnimationFrame = cb => { frames.push(cb); return frames.length; };
  try {
    click(row('alpha'));
    act(() => changeHost(removed ? null : second));
    assert.equal(first.slotRegistry.getAll('commandPalette').length, 1, 'old registry remains valid during provider retirement');
    act(() => { for (const cb of frames.splice(0)) cb(0); });
    await settle();
    assert.deepEqual(first.executions, []);
    assert.deepEqual(second.executions, []);
    assert.deepEqual(events, []);
    assert.equal(localStorage.getItem(RECENT_KEY), null);
  } finally { globalThis.requestAnimationFrame = previous; }
});

test('#8947 toolbar and keyboard preserve placement when, chord, owner and canonical dispatch count', async () => {
  const host = new PaletteCommandTestHost(); host.add('alpha'); host.add('beta');
  // Keep alpha's palette row but remove its placements, making beta's owner
  // binding distinguishable from first-owner storage resolution.
  const alpha = host.slotRegistry.getAll('commandPalette').find(c => c.extensionId === 'alpha')!;
  host.slotRegistry.unregister('alpha'); host.slotRegistry.register('alpha', [alpha]);
  const ui = render(<ExtensionHostContext.Provider value={host}>
    <ExtensionToolbarSlot slot="toolbar.right" /><ExtensionKeyboardBindings />
  </ExtensionHostContext.Provider>);
  const press = (shiftKey: boolean) => act(() => { window.dispatchEvent(new KeyboardEvent('keydown', {
    key: shiftKey ? 'G' : 'g', shiftKey, bubbles: true, cancelable: true,
  })); });
  assert.equal(ui.querySelector('button'), null);
  press(true); await settle();
  assert.deepEqual(host.events, []);
  act(() => useViewerStore.setState({ selectedEntityIds: new Set([42]) }));
  const button = ui.querySelector('button'); assert.ok(button);
  click(button); await settle();
  press(false); await settle();
  assert.deepEqual(host.executions, ['beta']);
  press(true); await settle();
  assert.deepEqual(host.executions, ['beta', 'beta']);
  assert.deepEqual(host.activations, ['beta', 'beta']);
  assert.deepEqual(host.events, ['onCommand:paint', 'onCommand:paint']);
  act(() => useViewerStore.setState({ selectedEntityIds: new Set() }));
  press(true); await settle();
  assert.deepEqual(host.executions, ['beta', 'beta']);
  act(() => host.slotRegistry.unregister('beta'));
  press(true); await settle();
  assert.deepEqual(host.events, ['onCommand:paint', 'onCommand:paint']);
});
