/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { packBundle, unpackBundle, type ExtensionManifest } from '@ifc-lite/extensions';
import { render, cleanup, click, advance } from '@/test/render';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';
import { useViewerStore } from '@/store';
import { ExtensionsPanel } from './ExtensionsPanel';
import { PromoteToolDialog } from './PromoteToolDialog';
const hosts: ExtensionHostService[] = [];
afterEach(async () => {
  cleanup(); useViewerStore.getState().setPendingAuthoredBundle(null);
  await Promise.all(hosts.splice(0).map(host => host.dispose()));
});
function hostFixture() {
  const host = new ExtensionHostService({ sdk: createBimContext({ transport: {
    send: () => Promise.reject(new Error('Unused SDK transport')), subscribe: () => () => {}, close() {},
  } }) });
  hosts.push(host); return host;
}
function bundle(name: string) {
  const manifest: ExtensionManifest = { manifestVersion: 1, id: `com.example.${name}`, name, description: 'Ownership fixture',
    version: '0.1.0', engines: { ifcLiteSdk: '>=1.0.0' }, capabilities: ['model.read'],
    activation: ['onCommand:run'], contributes: { commands: [{ id: 'run', title: name }] },
    entry: { commands: { run: 'src/run.js' } } };
  const bytes = packBundle({ manifest, source: { kind: 'memory' }, files: new Map([
    ['manifest.json', { path: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify(manifest)) }],
    ['src/run.js', { path: 'src/run.js', bytes: new TextEncoder().encode('function run() {}') }],
  ]) });
  const checked = unpackBundle(bytes);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  return bytes;
}
function choose(ui: HTMLElement, bytes: Uint8Array, name: string) {
  const input = ui.querySelector<HTMLInputElement>('input[type=file]')!;
  const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], `${name}.iflx`));
  Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await advance(10);
  assert.ok(predicate(), 'expected review state');
}
function reviewText() { return document.querySelector('[role=dialog]')?.textContent ?? ''; }
function button(name: string) {
  const found = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name);
  assert.ok(!!found, `button ${name}`); return found!;
}
for (const timing of ['open', 'pending'] as const) test(`file imports preserve the first ${timing} capability review`, async t => {
  const host = hostFixture(), preview = host.previewBundle.bind(host);
  let release!: () => void, calls = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host, 'previewBundle', async (bytes: Uint8Array) => { calls++; if (timing === 'pending') await held; return preview(bytes); });
  const ui = render(<ExtensionHostContext.Provider value={host}><ExtensionsPanel /></ExtensionHostContext.Provider>);
  choose(ui, bundle('first'), 'first');
  await until(() => timing === 'open' ? reviewText().includes('first') : calls === 1);
  choose(ui, bundle('second'), 'second');
  release(); await advance(100);
  assert.ok(reviewText().includes('first'));
  assert.equal(reviewText().includes('second'), false);
  assert.equal(calls, 1);
});
for (const stage of ['preview', 'installed'] as const) test(`a dropped file owns review ahead of late authored ${stage}`, async t => {
  const host = hostFixture(), preview = host.previewBundle.bind(host), authored = bundle('authored');
  let release!: () => void, started = false, holdInstalled = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host, 'previewBundle', async (bytes: Uint8Array) => {
    if (bytes === authored && stage === 'preview') { started = true; await held; }
    const result = await preview(bytes);
    if (bytes === authored && stage === 'installed') holdInstalled = true;
    return result;
  });
  t.mock.method(host, 'listInstalled', async () => { if (holdInstalled) { holdInstalled = false; started = true; await held; } return []; });
  useViewerStore.getState().setPendingAuthoredBundle(authored);
  const ui = render(<ExtensionHostContext.Provider value={host}><ExtensionsPanel /></ExtensionHostContext.Provider>);
  await until(() => started);
  choose(ui, bundle('dropped'), 'dropped');
  await until(() => reviewText().includes('dropped'));
  release(); await advance(100);
  assert.ok(reviewText().includes('dropped'));
  assert.equal(useViewerStore.getState().pendingAuthoredBundle === authored, true);
  click(button('Cancel')); await until(() => reviewText().includes('authored'));
});
test('closing promotion during packaging cannot open a late review', async t => {
  const host = hostFixture(), digest = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(crypto.subtle, 'digest', async (...args: Parameters<typeof digest>) => { await held; return digest(...args); });
  function Harness() {
    const [open, setOpen] = useState(true);
    return <><button onClick={() => setOpen(false)}>External close</button><button onClick={() => setOpen(true)}>Reopen</button><PromoteToolDialog open={open} initialName="Promoted" source="const x = 1;" onClose={() => setOpen(false)} /></>;
  }
  render(<ExtensionHostContext.Provider value={host}><Harness /></ExtensionHostContext.Provider>);
  click(button('Review & install'));
  const cancelDisabled = button('Cancel').disabled;
  click(button('External close')); release(); await advance(100);
  assert.equal(cancelDisabled, true);
  assert.equal(!!document.querySelector('[role=dialog]'), false);
  click(button('Reopen'));
  assert.ok(reviewText().includes('Review & install'), 'reopening retains the promotion form rather than a stale capability review');
});

test('replacing a queued authored source preserves the new bundle while the old preview settles', async t => {
  const host = hostFixture(), preview = host.previewBundle.bind(host), first = bundle('old'), second = bundle('new');
  let release!: () => void, started = false, oldSettled = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host, 'previewBundle', async (bytes: Uint8Array) => { if (bytes === first) { started = true; await held; } const result = await preview(bytes); if (bytes === first) oldSettled = true; return result; });
  useViewerStore.getState().setPendingAuthoredBundle(first);
  render(<ExtensionHostContext.Provider value={host}><ExtensionsPanel /></ExtensionHostContext.Provider>);
  await until(() => started);
  act(() => useViewerStore.getState().setPendingAuthoredBundle(second));
  release(); await until(() => oldSettled); await advance(20); await until(() => reviewText().includes('com.example.new'));
  assert.equal(reviewText().includes('com.example.old'), false);
});

test('a late install result cannot close a reopened promotion form', async t => {
  const host = hostFixture();
  let release!: () => void, started = false, finished = false, closes = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host, 'installFromBytes', async (bytes: Uint8Array, grants: string[]): Promise<Awaited<ReturnType<ExtensionHostService['installFromBytes']>>> => {
    started = true; await held;
    try {
      const preview = await host.previewBundle(bytes);
      if (!preview.ok) throw new Error('Invalid test bundle');
      const { id, version, bundleHash } = preview.value;
      return { id, version, ok: true, errors: [], bundle: preview.value.bundle,
        record: { id, version, bundleHash, enabled: true, grantedCapabilities: grants, installedAt: '2026-11-09T00:00:00Z', source: 'local' } };
    } finally { finished = true; }
  });
  function Harness() {
    const [open, setOpen] = useState(true);
    return <><button onClick={() => setOpen(false)}>External close</button><button onClick={() => setOpen(true)}>Reopen</button>
      <PromoteToolDialog open={open} initialName="Install owner" source="const x = 1;" onClose={() => { closes++; setOpen(false); }} /></>;
  }
  render(<ExtensionHostContext.Provider value={host}><Harness /></ExtensionHostContext.Provider>);
  click(button('Review & install')); await until(() => !!document.querySelector('[role=dialog]') && reviewText().includes('Install com.local.tools'));
  click(button('Install')); await until(() => started);
  click(button('External close')); click(button('Reopen'));
  release(); await until(() => finished); await advance(20);
  assert.equal(closes, 0);
  assert.ok(reviewText().includes('Review & install'));
});
