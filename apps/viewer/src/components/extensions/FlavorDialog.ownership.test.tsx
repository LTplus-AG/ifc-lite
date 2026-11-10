/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { packFlavor, type Flavor } from '@ifc-lite/extensions';
import { render, cleanup, click, advance } from '@/test/render';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';
import { toast } from '@/components/ui/toast';
import { FlavorDialog } from './FlavorDialog';
const hosts: ExtensionHostService[] = [];
afterEach(async () => { cleanup(); await Promise.all(hosts.splice(0).map(host => host.dispose())); });
function fixture() {
  const host = new ExtensionHostService({ sdk: createBimContext({ transport: {
    send: () => Promise.reject(new Error('Unused SDK transport')), subscribe: () => () => {}, close() {},
  } }) });
  hosts.push(host);
  function Harness() {
    const [open, setOpen] = useState(true);
    return <><button onClick={() => setOpen(false)}>Close flavor owner</button><button onClick={() => setOpen(true)}>Reopen flavor owner</button><FlavorDialog open={open} onClose={() => setOpen(false)} /></>;
  }
  render(<ExtensionHostContext.Provider value={host}><Harness /></ExtensionHostContext.Provider>);
  return host;
}
function bytes(name: string) {
  const flavor: Flavor = { schemaVersion: 1, id: `ownership.${name}`, name, description: '',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    extensions: [], lenses: [], savedQueries: [], keybindings: [], layout: { state: {} }, settings: {} };
  return packFlavor(flavor);
}
function choose(file: File) {
  const input = document.querySelector<HTMLInputElement>('input[accept=".iflv"]');
  assert.ok(!!input, 'flavor import input');
  const transfer = new DataTransfer(); transfer.items.add(file);
  Object.defineProperty(input!, 'files', { configurable: true, value: transfer.files });
  act(() => input!.dispatchEvent(new Event('change', { bubbles: true })));
}
function select(name: string) { choose(new File([new Uint8Array(bytes(name))], `${name}.iflv`)); }
function button(name: string) {
  const found = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === name);
  assert.ok(!!found, name); return found!;
}
function text() { return document.querySelector('[role=dialog]')?.textContent ?? ''; }
async function until(predicate: () => boolean) {
  for (let i = 0; i < 150 && !predicate(); i++) await advance(10);
  assert.ok(predicate(), 'expected flavor review state');
}
// PR #9581 duplicate-site review: real packed flavors and mounted controls.
test('two flavor imports retain the first pending review', async t => {
  const host = fixture(), preview = host.flavors.preview.bind(host.flavors);
  let release!: () => void, calls = 0, started = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host.flavors, 'preview', async (data: Uint8Array) => {
    calls++; const result = await preview(data);
    if (result.flavor.name === 'first') { started = true; await held; }
    return result;
  });
  try { select('first'); await until(() => started); select('second'); }
  finally { release(); }
  await until(() => text().includes('ownership.first')); await advance(20);
  assert.equal(calls, 1); assert.equal(text().includes('ownership.second'), false);
});
test('closing and reopening flavor import fences an abandoned preview and releases its bytes', async t => {
  const host = fixture(), preview = host.flavors.preview.bind(host.flavors);
  let release!: () => void, started = false, finished = false, abandoned: Uint8Array | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host.flavors, 'preview', async (data: Uint8Array) => {
    const result = await preview(data);
    if (result.flavor.name === 'old') { abandoned = data; started = true; await held; finished = true; }
    return result;
  });
  try {
    select('old'); await until(() => started);
    click(button('Close flavor owner')); click(button('Reopen flavor owner'));
    select('new'); await until(() => text().includes('ownership.new'));
  } finally { release(); }
  await until(() => finished); await advance(20);
  assert.equal(text().includes('ownership.old'), false);
  assert.equal(text().includes('ownership.new'), true);
  assert.equal(abandoned?.every(value => value === 0), true);
});
test('unmounting flavor preview suppresses its late error', async t => {
  const host = fixture(), errors: string[] = [];
  t.mock.method(toast, 'error', (message: string) => { errors.push(message); });
  let release!: () => void, started = false, finished = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host.flavors, 'preview', async () => { started = true; await held; finished = true; throw new Error('late preview failure'); });
  select('error'); await until(() => started); cleanup(); release(); await until(() => finished); await advance(20);
  assert.equal(errors.length, 0);
});
test('an abandoned flavor file read never starts preview', async t => {
  const host = fixture(); let previews = 0, release!: () => void, started = false, finished = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const preview = host.flavors.preview.bind(host.flavors);
  t.mock.method(host.flavors, 'preview', async (data: Uint8Array) => { previews++; return preview(data); });
  class HeldFile extends File {
    override async arrayBuffer(): Promise<ArrayBuffer> { started = true; await held; finished = true; return new Uint8Array(bytes('read')).buffer; }
  }
  choose(new HeldFile([], 'read.iflv')); await until(() => started); cleanup(); release(); await until(() => finished); await advance(20);
  assert.equal(previews, 0);
});
test('published flavor review buffers are cleared on Cancel and unmount', async t => {
  const host = fixture(), preview = host.flavors.preview.bind(host.flavors), captured: Uint8Array[] = [];
  t.mock.method(host.flavors, 'preview', async (data: Uint8Array) => { captured.push(data); return preview(data); });
  select('cancel'); await until(() => text().includes('ownership.cancel')); click(button('Cancel'));
  assert.equal(captured[0].every(value => value === 0), true);
  select('unmount'); await until(() => text().includes('ownership.unmount')); cleanup();
  assert.equal(captured[1].every(value => value === 0), true);
});
