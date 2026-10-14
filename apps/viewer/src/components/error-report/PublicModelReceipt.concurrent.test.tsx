/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { act, startTransition, Suspense, useState } from 'react';
import type { ReportReceipt } from '@ifc-lite/report-contract';
import { cleanup, click, render } from '@/test/render.js';
import { ReportClient } from '@/services/error-reports/client';
import { PublicModelReceipt } from './PublicModelReceipt';

const token = 'a'.repeat(64);
const available: ReportReceipt = { id: 'owned', status: 'published', publicModel: {
  state: 'available', downloadUrl: `/api/reports/public/${token}`,
} };
const releases = new Set<() => void>();
let phases = 0;
function phase(stage: string) {
  const path = process.env.RECEIPT_CONCURRENT_PHASE_LOG;
  if (!path || phases++ >= 96) return;
  const row = JSON.stringify({ pid: process.pid, at: Date.now(), stage });
  appendFileSync(path, row + '\n');
  console.info('[receipt-phase]', row);
}
function response() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  const release = () => resolve(Response.json({ message: 'Test cleanup' }, { status: 503 }));
  releases.add(release);
  return { promise, resolve(value: Response) { releases.delete(release); resolve(value); } };
}
async function settle() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
afterEach(async () => {
  phase('afterEach:before-cleanup');
  cleanup();
  phase('afterEach:after-cleanup');
  await act(async () => {
    phase('afterEach:before-release');
    for (const release of releases) release();
    releases.clear();
    phase('afterEach:after-release');
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  phase('afterEach:complete');
});
function button(text: string) {
  const found = [...document.querySelectorAll('button')].find(node => node.textContent === text);
  assert.ok(found, `Mounted button: ${text}`);
  return found;
}
function mount(client: ReportClient) {
  let update!: (next: { receipt: ReportReceipt; blocked: boolean }) => void;
  let complete!: () => void;
  let pendingGate = true;
  const blocked = new Promise<void>(done => { complete = done; });
  const release = () => { pendingGate = false; complete(); };
  releases.add(release);
  let suspendedRenders = 0;
  const changes: ReportReceipt[] = [];
  // This sibling renders AFTER the real receipt component. Throwing here
  // abandons its speculative work without committing a replacement receipt.
  function Gate({ suspend }: { suspend: boolean }) {
    if (suspend && pendingGate) {
      if (suspendedRenders++ === 0) phase('Gate:first-pending-suspension');
      throw blocked;
    }
    return <span data-committed-report="yes" />;
  }
  function Parent() {
    const [state, setState] = useState({ receipt: available, blocked: false });
    update = setState;
    return <Suspense fallback={<p data-suspended-fallback="yes">Loading report</p>}>
      <PublicModelReceipt receipt={state.receipt} client={client} onChange={next => {
        changes.push(next); setState({ receipt: next, blocked: false });
      }} />
      <Gate suspend={state.blocked} />
    </Suspense>;
  }
  render(<Parent />);
  return {
    changes,
    commit(next: ReportReceipt) {
      phase(`commit:${next.id}:before`);
      act(() => update({ receipt: next, blocked: false }));
      phase(`commit:${next.id}:after`);
    },
    async abandon(next: ReportReceipt) {
      phase(`abandon:${next.id}:before`);
      const before = suspendedRenders;
      await act(async () => {
        startTransition(() => update({ receipt: next, blocked: true }));
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      phase(`abandon:${next.id}:after-act`);
      assert.ok(suspendedRenders > before, 'The speculative receipt render reached its suspending sibling');
      assert.ok(document.querySelector('[data-committed-report]'), 'Original committed UI remains mounted');
      assert.equal(document.querySelector('[data-suspended-fallback]'), null, 'Transition did not commit fallback');
    },
  };
}

// #7495 / review4269567835: a real concurrent render must not invalidate a
// response to the still-committed receipt, even when its transport ignores abort.
for (const outcome of ['success', 'error'] as const) {
  test(`#7495 abandoned same-report render preserves valid public GET ${outcome}`, async () => {
    phase(`GET:${outcome}:begin`);
    const pending = response();
    const observed: { signal?: AbortSignal | null } = {};
    const ui = mount(new ReportClient(async (_url, options) => {
      observed.signal = options?.signal; return pending.promise;
    }));
    click(button('Check public model status'));
    await ui.abandon({ ...available });
    assert.equal(observed.signal?.aborted, false, 'Uncommitted props did not abort the live GET');
    pending.resolve(outcome === 'success'
      ? Response.json({ ...available, publicModel: { state: 'held' } })
      : Response.json({ message: 'Live status service failed' }, { status: 503 }));
    await settle();
    phase(`GET:${outcome}:after-response-settle`);
    if (outcome === 'success') {
      assert.equal(ui.changes.length, 1, 'Valid response reached the committed parent');
      assert.equal(document.querySelector('a[href*="/public/"]'), null, 'Held receipt removed download');
      assert.equal(document.querySelector('[role="alert"]'), null);
    } else {
      assert.equal(ui.changes.length, 0);
      assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /Live status service failed/);
      assert.equal(button('Check public model status').disabled, false);
    }
  });
}

for (const terminal of ['withdrawn', 'deleted'] as const) {
  test(`#7495 abandoned different-report render preserves committed ${terminal} terminal state`, async () => {
    phase(`terminal:${terminal}:begin`);
    const pending = response();
    const ui = mount(new ReportClient(async () => pending.promise));
    if (terminal === 'withdrawn') {
      click(button('Stop public model sharing'));
      click(button('Confirm stop public sharing'));
      phase('terminal:withdrawn:before-response');
      pending.resolve(Response.json({ ...available, publicModel: { state: 'withdrawn' } }));
      await settle();
      phase('terminal:withdrawn:after-response-settle');
      assert.equal(ui.changes.length, 1, 'Real confirmed withdrawal reached parent');
    } else {
      ui.commit({ id: available.id, status: 'deleted' });
    }
    assert.equal(document.querySelector('a[href*="/public/"]'), null);
    await ui.abandon({ ...available, id: 'speculative-other' });
    phase(`terminal:${terminal}:after-abandon`);
    ui.commit({ ...available }); // Older same-report snapshot after abandoned work.
    phase(`terminal:${terminal}:after-stale-commit`);
    assert.equal(document.querySelector('a[href*="/public/"]'), null, 'Terminal report cannot resume downloads');
    assert.equal(document.querySelector('button'), null, 'Terminal report cannot resume sharing controls');
    if (terminal === 'withdrawn') assert.match(document.body.textContent ?? '', /New downloads are blocked/);
    else assert.equal(document.querySelector('section'), null);
    ui.commit({ ...available, id: 'committed-other' });
    assert.ok(document.querySelector(`a[href="/api/reports/public/${token}"]`), 'A committed report change resets terminal state');
    assert.equal(button('Check public model status').disabled, false);
  });
}
