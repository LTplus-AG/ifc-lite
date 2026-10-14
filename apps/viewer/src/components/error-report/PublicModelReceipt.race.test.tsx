/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import type { ReportReceipt } from '@ifc-lite/report-contract';
import { cleanup, click, render } from '@/test/render.js';
import { ReportClient } from '@/services/error-reports/client';
import { PublicModelReceipt } from './PublicModelReceipt';

afterEach(cleanup);
const token = 'a'.repeat(64);
const available: ReportReceipt = { id: 'owned', status: 'published', publicModel: {
  state: 'available', downloadUrl: `/api/reports/public/${token}`,
} };
const withdrawn: ReportReceipt = { ...available, publicModel: { state: 'withdrawn' } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function button(text: string) {
  const element = [...document.querySelectorAll('button')].find(node => node.textContent === text);
  assert.ok(element, `button ${text}`); return element;
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); }
function mount(client: ReportClient) {
  let update!: (receipt: ReportReceipt) => void;
  const changes: ReportReceipt[] = [];
  function Parent() {
    const [receipt, setReceipt] = useState(available); update = setReceipt;
    return <PublicModelReceipt receipt={receipt} client={client} onChange={next => { changes.push(next); setReceipt(next); }} />;
  }
  render(<Parent />);
  return { changes, update: (receipt: ReportReceipt) => act(() => update(receipt)) };
}
function assertWithdrawn() {
  assert.equal(document.querySelector('a[href*="/public/"]'), null);
  assert.ok(document.body.textContent?.includes('New downloads are blocked'));
  assert.equal(document.querySelector('button'), null, 'Withdrawn model has no status or withdrawal controls');
}

// #7495 review4267322932: obsolete transport success AND failure must not
// replace an authoritative same-report withdrawal received through parent props.
for (const outcome of ['success', 'error'] as const) test(`#7495 stale public GET ${outcome} cannot resurrect a withdrawn parent receipt`, async () => {
  const old = deferred<Response>(); const observed: { signal?: AbortSignal | null } = {};
  const client = new ReportClient(async (_url, options) => { observed.signal = options?.signal; return old.promise; });
  const ui = mount(client);
  click(button('Check public model status'));
  ui.update(withdrawn);
  assert.equal(observed.signal?.aborted, true, 'Superseded GET is aborted');
  assertWithdrawn();
  old.resolve(outcome === 'success' ? Response.json(available) : Response.json({ message: 'Obsolete response' }, { status: 503 }));
  await settle();
  assertWithdrawn();
  assert.deepEqual(ui.changes, [], 'An abort-ignoring transport cannot publish a stale result');
  assert.equal(document.querySelector('[role="alert"]'), null, 'Obsolete error is ignored');
});

test('#7495 confirmed withdrawal survives concurrent parent refresh and a later available snapshot, then resets for another report', async () => {
  const deletion = deferred<Response>(); const observed: { signal?: AbortSignal | null } = {};
  const calls: string[] = [];
  const client = new ReportClient(async (url, options) => {
    calls.push(`${options?.method} ${String(url)}`); observed.signal = options?.signal; return deletion.promise;
  });
  const ui = mount(client);
  click(button('Stop public model sharing'));
  assert.deepEqual(calls, []);
  click(button('Confirm stop public sharing'));
  assert.deepEqual(calls, ['DELETE /api/reports/owned/public-model']);
  ui.update({ ...available }); // A parent GET completed while authoritative DELETE is in flight.
  assert.equal(observed.signal?.aborted, false, 'Same-report refresh does not discard authoritative withdrawal');
  deletion.resolve(Response.json(withdrawn));
  await settle();
  assert.equal(ui.changes.length, 1);
  assert.equal(ui.changes[0]?.publicModel?.state, 'withdrawn');
  assertWithdrawn();
  ui.update({ ...available }); // A second, older parent snapshot arrives after confirmation.
  assertWithdrawn();
  ui.update({ ...available, id: 'another' });
  assert.ok(document.querySelector(`a[href="/api/reports/public/${token}"]`), 'Different report resets terminal withdrawal');
  assert.equal(button('Check public model status').disabled, false);
});

test('#7495 obsolete GET completion cannot clear a newer report pending request', async () => {
  const first = deferred<Response>(); const second = deferred<Response>();
  const client = new ReportClient(async url => String(url).endsWith('/owned') ? first.promise : second.promise);
  const ui = mount(client);
  click(button('Check public model status'));
  ui.update({ ...available, id: 'another' });
  click(button('Check public model status'));
  first.resolve(Response.json(available));
  await settle();
  assert.equal(button('Check public model status').disabled, true, 'Newer request retains its busy ownership');
  assert.equal(ui.changes.length, 0);
  second.resolve(Response.json({ ...withdrawn, id: 'another' }));
  await settle();
  assertWithdrawn();
  assert.deepEqual(ui.changes.map(receipt => receipt.id), ['another']);
});


test('#7495 private deletion remains terminal across an older same-report available snapshot', () => {
  const ui = mount(new ReportClient(async () => { throw new Error('No request expected'); }));
  ui.update({ id: 'owned', status: 'deleted' });
  assert.equal(document.querySelector('section'), null);
  ui.update({ ...available });
  assert.equal(document.querySelector('section'), null, 'Old available snapshot cannot restore deleted report controls');
  ui.update({ ...available, id: 'another' });
  assert.ok(document.querySelector(`a[href="/api/reports/public/${token}"]`), 'Different report resets deletion terminal state');
});

test('#7495 pending public DELETE cannot reopen a privately deleted report after stale parent refresh', async () => {
  const deletion = deferred<Response>(); const observed: { signal?: AbortSignal | null } = {};
  const client = new ReportClient(async (_url, options) => { observed.signal = options?.signal; return deletion.promise; });
  const ui = mount(client);
  click(button('Stop public model sharing'));
  click(button('Confirm stop public sharing'));
  ui.update({ id: 'owned', status: 'deleted' });
  assert.equal(observed.signal?.aborted, true, 'Private deletion invalidates pending public withdrawal');
  ui.update({ ...available });
  assert.equal(document.querySelector('section'), null);
  deletion.resolve(Response.json(withdrawn));
  await settle();
  assert.equal(document.querySelector('section'), null, 'Late public DELETE cannot reopen deleted report');
  assert.deepEqual(ui.changes, [], 'Obsolete public receipt never updates parent');
  ui.update({ ...available, id: 'another' });
  assert.equal(button('Check public model status').disabled, false);
});
