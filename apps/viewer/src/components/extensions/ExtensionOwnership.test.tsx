/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useLayoutEffect, useState } from 'react';
import { createBimContext } from '@ifc-lite/sdk';
import { packBundle, unpackBundle, type ExtensionManifest } from '@ifc-lite/extensions';
import { render, cleanup, click, advance } from '@/test/render';
import { ExtensionHostContext } from '@/sdk/ExtensionHostProvider';
import { ExtensionHostService } from '@/services/extensions/host';
import { useViewerStore } from '@/store';
import { toast } from '@/components/ui/toast';
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
  click(button('Close'));
  const refusedDismissal = !!document.querySelector('[role=dialog]');
  click(button('External close')); release(); await advance(100);
  assert.equal(cancelDisabled, true);
  assert.equal(refusedDismissal, true, 'busy packaging refuses the dialog dismiss button');
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


test('an abandoned file read cannot publish a late error toast', async t => {
  const host = hostFixture(), errors: string[] = [];
  t.mock.method(toast, 'error', (message: string) => { errors.push(message); });
  let release!: () => void, started = false, finished = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  class BrokenFile extends File {
    override async arrayBuffer(): Promise<ArrayBuffer> { started = true; await held; finished = true; throw new Error('late read failure'); }
  }
  const ui = render(<ExtensionHostContext.Provider value={host}><ExtensionsPanel /></ExtensionHostContext.Provider>);
  const input = ui.querySelector<HTMLInputElement>('input[type=file]')!;
  const transfer = new DataTransfer(); transfer.items.add(new BrokenFile([], 'broken.iflx'));
  Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  await until(() => started); cleanup(); release(); await until(() => finished); await advance(20);
  assert.equal(errors.length, 0);
});

test('a failed obsolete authored preview preserves its replacement and suppresses its toast', async t => {
  const host = hostFixture(), preview = host.previewBundle.bind(host), first = bundle('obsolete'), second = bundle('replacement');
  const errors: string[] = [];
  t.mock.method(toast, 'error', (message: string) => { errors.push(message); });
  let release!: () => void, started = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host, 'previewBundle', async (bytes: Uint8Array) => {
    if (bytes === first) { started = true; await held; throw new Error('obsolete preview failed'); }
    return preview(bytes);
  });
  useViewerStore.getState().setPendingAuthoredBundle(first);
  render(<ExtensionHostContext.Provider value={host}><ExtensionsPanel /></ExtensionHostContext.Provider>);
  await until(() => started); act(() => useViewerStore.getState().setPendingAuthoredBundle(second)); release();
  await until(() => reviewText().includes('com.example.replacement'));
  assert.equal(errors.length, 0);
});

test('a closed promotion form suppresses a late packaging error', async t => {
  const host = hostFixture(), errors: string[] = [];
  t.mock.method(toast, 'error', (message: string) => { errors.push(message); });
  let release!: () => void, finished = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(crypto.subtle, 'digest', async () => { await held; finished = true; throw new Error('late packaging failure'); });
  function Harness() {
    const [open, setOpen] = useState(true);
    return <><button onClick={() => setOpen(false)}>External close</button><PromoteToolDialog open={open} source="const x = 1;" onClose={() => setOpen(false)} /></>;
  }
  render(<ExtensionHostContext.Provider value={host}><Harness /></ExtensionHostContext.Provider>);
  click(button('Review & install')); click(button('External close')); release();
  await until(() => finished); await advance(20);
  assert.equal(errors.length, 0);
});

test('a reopened promotion form suppresses the abandoned install error', async t => {
  const host = hostFixture(), errors: string[] = [];
  t.mock.method(toast, 'error', (message: string) => { errors.push(message); });
  let release!: () => void, started = false, finished = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host, 'installFromBytes', async () => { started = true; await held; finished = true; throw new Error('late install failure'); });
  function Harness() {
    const [open, setOpen] = useState(true);
    return <><button onClick={() => setOpen(false)}>External close</button><button onClick={() => setOpen(true)}>Reopen</button>
      <PromoteToolDialog open={open} initialName="Abandoned install" source="const x = 1;" onClose={() => setOpen(false)} /></>;
  }
  render(<ExtensionHostContext.Provider value={host}><Harness /></ExtensionHostContext.Provider>);
  click(button('Review & install')); await until(() => reviewText().includes('Install com.local.tools'));
  click(button('Install')); await until(() => started); click(button('External close')); click(button('Reopen')); release();
  await until(() => finished); await advance(20);
  assert.equal(errors.length, 0);
  assert.ok(reviewText().includes('Review & install'));
});


test('an abandoned successful file read never starts bundle preview', async t => {
  const host = hostFixture(), preview = host.previewBundle.bind(host);
  let release!: () => void, started = false, finished = false, previews = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host, 'previewBundle', async (bytes: Uint8Array) => { previews++; return preview(bytes); });
  class HeldFile extends File {
    override async arrayBuffer(): Promise<ArrayBuffer> { started = true; await held; const result = await super.arrayBuffer(); finished = true; return result; }
  }
  const ui = render(<ExtensionHostContext.Provider value={host}><ExtensionsPanel /></ExtensionHostContext.Provider>);
  const input = ui.querySelector<HTMLInputElement>('input[type=file]')!, transfer = new DataTransfer();
  transfer.items.add(new HeldFile([new Uint8Array(bundle('abandoned'))], 'abandoned.iflx'));
  Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  await until(() => started); cleanup(); release(); await until(() => finished); await advance(20);
  assert.equal(previews, 0);
});

test('an older authored finally cannot remove priority from its replacement run', async t => {
  const host = hostFixture(), preview = host.previewBundle.bind(host), authored = bundle('authoredfinally');
  let releaseOld!: () => void, releaseNew!: () => void, attempts = 0, oldFinished = false;
  const oldHeld = new Promise<void>(resolve => { releaseOld = resolve; }), newHeld = new Promise<void>(resolve => { releaseNew = resolve; });
  const errors: string[] = [];
  t.mock.method(toast, 'error', (message: string) => { errors.push(message); });
  t.mock.method(host, 'previewBundle', async (bytes: Uint8Array) => {
    let attempt = 0;
    if (bytes === authored) { attempt = ++attempts; await (attempt === 1 ? oldHeld : newHeld); }
    const result = await preview(bytes);
    if (result.ok && result.value.id === 'com.example.failedfile') throw new Error('file preview failed');
    if (attempt === 1) oldFinished = true;
    return result;
  });
  useViewerStore.getState().setPendingAuthoredBundle(authored);
  const ui = render(<ExtensionHostContext.Provider value={host}><ExtensionsPanel /></ExtensionHostContext.Provider>);
  try {
    await until(() => attempts === 1); choose(ui, bundle('failedfile'), 'failedfile'); await until(() => attempts === 2);
    releaseOld(); await until(() => oldFinished); await advance(20);
    choose(ui, bundle('priority'), 'priority'); await until(() => reviewText().includes('com.example.priority'));
    assert.equal(errors.length, 1);
  } finally { releaseOld(); releaseNew(); await advance(20); }
});

test('closing an existing promotion review removes it in the closing commit', async () => {
  const host = hostFixture();
  let visibleAtClose: boolean | undefined;
  function Harness() {
    const [open, setOpen] = useState(true);
    useLayoutEffect(() => { if (!open) visibleAtClose = !!document.querySelector('[role=dialog]'); }, [open]);
    return <><button onClick={() => setOpen(false)}>External close</button>
      <PromoteToolDialog open={open} initialName="Render owner" source="const x = 1;" onClose={() => setOpen(false)} /></>;
  }
  render(<ExtensionHostContext.Provider value={host}><Harness /></ExtensionHostContext.Provider>);
  click(button('Review & install')); await until(() => reviewText().includes('Install com.local.tools'));
  click(button('External close'));
  assert.equal(visibleAtClose, false);
});

for (const origin of ['file', 'authored'] as const) test(`rejected ${origin} bundles retain their unpack-failure message (PR #9581)`, async t => {
  const host = hostFixture(), errors: string[] = [];
  t.mock.method(toast, 'error', (message: string) => { errors.push(message); });
  if (origin === 'authored') useViewerStore.getState().setPendingAuthoredBundle(new Uint8Array([1, 2, 3]));
  const ui = render(<ExtensionHostContext.Provider value={host}><ExtensionsPanel /></ExtensionHostContext.Provider>);
  if (origin === 'file') choose(ui, new Uint8Array([1, 2, 3]), 'invalid');
  await until(() => errors.length > 0);
  assert.equal(errors[0].startsWith(origin === 'file' ? 'Bundle did not unpack:' : "Authored bundle didn't unpack:"), true);
});

test('a file read failure keeps its read-failure message (PR #9581)', async t => {
  const host = hostFixture(), errors: string[] = [];
  t.mock.method(toast, 'error', (message: string) => { errors.push(message); });
  class BrokenFile extends File { override async arrayBuffer(): Promise<ArrayBuffer> { throw new Error('read denied'); } }
  const ui = render(<ExtensionHostContext.Provider value={host}><ExtensionsPanel /></ExtensionHostContext.Provider>);
  const input = ui.querySelector<HTMLInputElement>('input[type=file]')!;
  const transfer = new DataTransfer(); transfer.items.add(new BrokenFile([], 'broken.iflx'));
  Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
  act(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  await until(() => errors.length > 0);
  assert.equal(errors[0], 'Failed to read file: read denied');
});
test('an authored preview exception keeps its preview-failure message (PR #9581)', async t => {
  const host = hostFixture(), errors: string[] = [];
  t.mock.method(toast, 'error', (message: string) => { errors.push(message); });
  t.mock.method(host, 'previewBundle', async () => { throw new Error('preview engine failed'); });
  useViewerStore.getState().setPendingAuthoredBundle(bundle('failed'));
  render(<ExtensionHostContext.Provider value={host}><ExtensionsPanel /></ExtensionHostContext.Provider>);
  await until(() => errors.length > 0);
  assert.equal(errors[0], 'Authored bundle preview failed: preview engine failed');
});

test('PR #9581 B1: a held install and Cancel cannot consume a newer authored review', async t => {
  const host = hostFixture(), put = host.storage.putBundle.bind(host.storage), install = host.installFromBytes.bind(host);
  const first = bundle('firstfile'), second = bundle('queuedreview'), successes: string[] = [];
  let release!: () => void, started = false, finished = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host.storage, 'putBundle', async (...args: Parameters<typeof put>) => { if (args[0] === 'com.example.firstfile') { started = true; await held; } await put(...args); });
  t.mock.method(host, 'installFromBytes', async (...args: Parameters<typeof install>) => { try { return await install(...args); } finally { finished = true; } });
  t.mock.method(toast, 'success', (message: string) => { successes.push(message); });
  const ui = render(<ExtensionHostContext.Provider value={host}><ExtensionsPanel /></ExtensionHostContext.Provider>);
  try {
    choose(ui, first, 'firstfile'); await until(() => reviewText().includes('com.example.firstfile'));
    click(button('Install')); await until(() => started);
    const cancelDisabled = button('Cancel').disabled;
    click(button('Cancel'));
    act(() => useViewerStore.getState().setPendingAuthoredBundle(second));
    await advance(30);
    release(); await until(() => finished); await advance(100);
    assert.equal(reviewText().includes('com.example.queuedreview'), true, 'the first install cannot close the newer review');
    assert.equal(cancelDisabled, true, 'Cancel stays disabled during installation');
    assert.equal(successes.length, 1);
    assert.equal((await host.storage.getExtension('com.example.firstfile'))?.id, 'com.example.firstfile');
  } finally { release(); await advance(20); }
});

test('PR #9581: file preview exposes busy state on Import and the drop zone', async t => {
  const host = hostFixture(), preview = host.previewBundle.bind(host);
  let release!: () => void, started = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host, 'previewBundle', async (bytes: Uint8Array) => { started = true; await held; return preview(bytes); });
  const ui = render(<ExtensionHostContext.Provider value={host}><ExtensionsPanel /></ExtensionHostContext.Provider>);
  try {
    choose(ui, bundle('busypreview'), 'busypreview'); await until(() => started);
    assert.equal(button('Import').disabled, true);
    assert.equal(ui.querySelector('[aria-disabled="true"]') !== null, true, 'the drop zone announces its disabled state');
  } finally { release(); await advance(30); }
});

test('PR #9581: promotion reports a committed install after external close without closing its replacement', async t => {
  const host = hostFixture(), put = host.storage.putBundle.bind(host.storage), install = host.installFromBytes.bind(host), successes: string[] = [];
  let release!: () => void, started = false, finished = false, closes = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host.storage, 'putBundle', async (...args: Parameters<typeof put>) => { started = true; await held; await put(...args); });
  t.mock.method(host, 'installFromBytes', async (...args: Parameters<typeof install>) => { try { return await install(...args); } finally { finished = true; } });
  t.mock.method(toast, 'success', (message: string) => { successes.push(message); });
  function Harness() {
    const [open, setOpen] = useState(true);
    return <><button onClick={() => setOpen(false)}>External close</button><button onClick={() => setOpen(true)}>Reopen</button>
      <PromoteToolDialog open={open} initialName="Global install" source="const x = 1;" onClose={() => { closes++; setOpen(false); }} /></>;
  }
  render(<ExtensionHostContext.Provider value={host}><Harness /></ExtensionHostContext.Provider>);
  try {
    click(button('Review & install')); await until(() => reviewText().includes('Install com.local.tools'));
    click(button('Install')); await until(() => started);
    click(button('External close')); click(button('Reopen')); release();
    await until(() => finished); await advance(20);
    assert.equal((await host.listInstalled()).some(row => row.id === 'com.local.tools.global-install'), true);
    assert.equal(successes.length, 1, 'a successful global install remains visible to the user');
    assert.equal(closes, 0);
    assert.equal(reviewText().includes('Review & install'), true);
  } finally { release(); await advance(20); }
});

for (const outcome of ['success', 'failure'] as const) test(`PR #9581: an unmounted panel suppresses stale install ${outcome} feedback`, async t => {
  const host = hostFixture(), install = host.installFromBytes.bind(host), notices: string[] = [];
  let release!: () => void, started = false, finished = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host, 'installFromBytes', async (...args: Parameters<typeof install>) => {
    started = true;
    await held;
    try {
      if (outcome === 'failure') throw new Error('Installation rejected');
      return await install(...args);
    } finally { finished = true; }
  });
  t.mock.method(toast, 'success', (message: string) => { notices.push(message); });
  t.mock.method(toast, 'error', (message: string) => { notices.push(message); });
  const ui = render(<ExtensionHostContext.Provider value={host}><ExtensionsPanel /></ExtensionHostContext.Provider>);
  try {
    choose(ui, bundle('closedinstall'), 'closedinstall'); await until(() => reviewText().includes('com.example.closedinstall'));
    click(button('Install')); await until(() => started);
    cleanup(); release(); await until(() => finished); await advance(20);
    assert.equal(notices.length, 0);
    if (outcome === 'success') assert.equal((await host.storage.getExtension('com.example.closedinstall'))?.id, 'com.example.closedinstall');
  } finally { release(); await advance(20); }
});

test('PR #9581: an installation keeps its review through Cancel and dialog dismissal', async t => {
  const host = hostFixture(), install = host.installFromBytes.bind(host);
  let release!: () => void, started = false, finished = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host, 'installFromBytes', async (...args: Parameters<typeof install>) => {
    started = true; await held;
    try { return await install(...args); } finally { finished = true; }
  });
  const ui = render(<ExtensionHostContext.Provider value={host}><ExtensionsPanel /></ExtensionHostContext.Provider>);
  try {
    choose(ui, bundle('lockedreview'), 'lockedreview'); await until(() => reviewText().includes('com.example.lockedreview'));
    click(button('Install')); await until(() => started);
    assert.equal(button('Install').disabled, true);
    click(button('Cancel'));
    assert.equal(reviewText().includes('com.example.lockedreview'), true, 'Cancel preserves the installing review');
    click(button('Close'));
    assert.equal(reviewText().includes('com.example.lockedreview'), true, 'dialog dismissal preserves the installing review');
  } finally { release(); await until(() => finished); await advance(20); }
});

for (const surface of ['panel', 'promotion'] as const) test(`PR #9581: ${surface} installation refuses same-tick approval and busy dismissal`, async t => {
  const host = hostFixture(), install = host.installFromBytes.bind(host);
  let release!: () => void, calls = 0, finished = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(host, 'installFromBytes', async (...args: Parameters<typeof install>) => {
    calls++;
    await held;
    try { return await install(...args); } finally { finished++; }
  });
  const ui = render(<ExtensionHostContext.Provider value={host}>{surface === 'panel'
    ? <ExtensionsPanel /> : <PromoteToolDialog open initialName="Double approval" source="const x = 1;" onClose={() => {}} />}</ExtensionHostContext.Provider>);
  try {
    if (surface === 'panel') choose(ui, bundle('sameapproval'), 'sameapproval');
    else click(button('Review & install'));
    await until(() => reviewText().includes(surface === 'panel' ? 'com.example.sameapproval' : 'Install com.local.tools'));
    const approve = button('Install');
    act(() => { approve.click(); approve.click(); });
    await until(() => calls > 0);
    assert.equal(calls, 1, 'the run lease refuses a second approval in the same render');
    assert.equal(button('Cancel').disabled, true);
    click(button('Close'));
    assert.equal(reviewText().includes(surface === 'panel' ? 'com.example.sameapproval' : 'Install com.local.tools'), true);
  } finally { release(); await until(() => finished === calls); await advance(20); }
});
