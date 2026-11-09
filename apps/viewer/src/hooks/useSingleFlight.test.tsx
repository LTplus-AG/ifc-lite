/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { useSingleFlight } from './useSingleFlight.js';

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function Probe({ task, log }: { task: () => Promise<string>; log: string[] }) {
  const flight = useSingleFlight();
  return <>
    <button data-run disabled={flight.busy} onClick={() => {
      void flight.run(async isCurrent => {
        const value = await task();
        log.push(`${value}:${isCurrent() ? 'current' : 'stale'}`);
        return value;
      }).then(result => log.push(`result:${result.status}`), error => log.push(`error:${String(error)}`));
    }}>run</button>
    <button data-release onClick={flight.release}>release</button>
    <span data-busy>{String(flight.busy)}</span>
  </>;
}

const q = (ui: HTMLElement, selector: string) => { const node = ui.querySelector(selector); assert.ok(node); return node as HTMLElement; };
/** A double-click: both presses land before React re-renders the button disabled. */
const pressTwice = (node: HTMLElement) => act(() => {
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});
const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

test('useSingleFlight refuses a second run in the same tick, before busy re-renders (C-9/C-2/C-11 double submit)', async () => {
  const pending = deferred<string>();
  let calls = 0;
  const log: string[] = [];
  const ui = render(<Probe log={log} task={() => { calls += 1; return pending.promise; }} />);
  pressTwice(q(ui, '[data-run]'));
  await settle();
  assert.equal(calls, 1, 'the synchronous lease, not the disabled button, refuses the second press');
  assert.deepEqual(log, ['result:refused']);
  assert.equal(q(ui, '[data-busy]').textContent, 'true');
  assert.equal((q(ui, '[data-run]') as HTMLButtonElement).disabled, true, 'controls can disable while busy');
  await act(async () => { pending.resolve('a'); await pending.promise; });
  await settle();
  assert.deepEqual(log, ['result:refused', 'a:current', 'result:done']);
  assert.equal(q(ui, '[data-busy]').textContent, 'false');
});

test('useSingleFlight clears busy when the task rejects, and lets the caller see the error', async () => {
  const pending = deferred<string>();
  const log: string[] = [];
  const ui = render(<Probe log={log} task={() => pending.promise} />);
  click(q(ui, '[data-run]'));
  await act(async () => { pending.reject(new Error('boom')); await pending.promise.catch(() => undefined); });
  await settle();
  assert.deepEqual(log, ['error:Error: boom']);
  assert.equal(q(ui, '[data-busy]').textContent, 'false', 'a rejected run cannot leave the owner stuck busy');
});

test('useSingleFlight release lets a newer run start; the older run is stale and its settle cannot clear the newer busy', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const queue = [first, second];
  const log: string[] = [];
  const ui = render(<Probe log={log} task={() => queue.shift()!.promise} />);
  click(q(ui, '[data-run]'));
  click(q(ui, '[data-release]'));
  assert.equal(q(ui, '[data-busy]').textContent, 'false');
  click(q(ui, '[data-run]'));
  assert.equal(q(ui, '[data-busy]').textContent, 'true');
  await act(async () => { first.resolve('old'); await first.promise; });
  await settle();
  assert.deepEqual(log, ['old:stale', 'result:stale']);
  assert.equal(q(ui, '[data-busy]').textContent, 'true', 'the older finally does not clobber the newer run');
  await act(async () => { second.resolve('new'); await second.promise; });
  await settle();
  assert.deepEqual(log, ['old:stale', 'result:stale', 'new:current', 'result:done']);
  assert.equal(q(ui, '[data-busy]').textContent, 'false');
});

test('useSingleFlight treats a run that settles after unmount as stale', async () => {
  const pending = deferred<string>();
  const log: string[] = [];
  const ui = render(<Probe log={log} task={() => pending.promise} />);
  click(q(ui, '[data-run]'));
  cleanup();
  await act(async () => { pending.resolve('late'); await pending.promise; });
  await settle();
  assert.equal(ui.isConnected, false);
  assert.deepEqual(log, ['late:stale', 'result:stale'], 'an unmounted owner no longer holds the flight');
});
