/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { toast } from '@/components/ui/toast';
import { registerEnglish } from '@/i18n';
import { reviewWorkspaceEn } from '@/i18n/catalogues/review-workspace.en';
import { reviewWorkspaceLibrary } from '@/lib/review/workspace';
import { ReviewDecision } from './ReviewDecision.js';

registerEnglish(reviewWorkspaceEn);
afterEach(() => { cleanup(); mock.restoreAll(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
const DECISION = { cardKey: 'card-1', status: 'accepted' as const, comment: 'Keep it', updatedAt: '2026-01-01T00:00:00.000Z' };
const button = (ui: HTMLElement, name: string) => {
  const node = [...ui.querySelectorAll('button')].find(entry => entry.textContent?.trim() === name);
  assert.ok(node, `${name} button`); return node;
};
/** A double-click: both presses land in one act(), before React re-renders the button disabled. */
const pressTwice = (node: Element) => act(() => {
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
});
const settle = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

test('C-11 ReviewDecision double-clicked Save writes once and disables Save and Clear while in flight', async () => {
  const pending = deferred<boolean>();
  const put = mock.method(reviewWorkspaceLibrary, 'put', () => pending.promise);
  const ui = render(<ReviewDecision cardKey="card-1" decision={DECISION} />);
  pressTwice(button(ui, 'Save decision'));
  await settle();
  assert.equal(put.mock.callCount(), 1, 'a second press during the in-flight save is refused');
  assert.equal(button(ui, 'Save decision').disabled, true);
  assert.equal(button(ui, 'Clear decision').disabled, true);
  await act(async () => { pending.resolve(true); await pending.promise; });
  await settle();
  assert.equal(button(ui, 'Save decision').disabled, false);
});

test('C-11 ReviewDecision locks the comment while Clear is in flight so its late reset cannot wipe new typing', async () => {
  const pending = deferred<boolean>();
  mock.method(reviewWorkspaceLibrary, 'put', () => pending.promise);
  const ui = render(<ReviewDecision cardKey="card-1" decision={DECISION} />);
  const comment = ui.querySelector('textarea'); assert.ok(comment);
  const status = ui.querySelector('select'); assert.ok(status);
  click(button(ui, 'Clear decision'));
  assert.equal(comment.disabled, true, 'the comment cannot be edited while Clear is pending');
  assert.equal(status.disabled, true, 'the status cannot be edited while Clear is pending');
  await act(async () => { pending.resolve(true); await pending.promise; });
  await settle();
  assert.equal(comment.disabled, false);
  assert.equal(comment.value, '', 'the resolved Clear resets the draft it was pressed on');
});

test('C-11 ReviewDecision reports a rejected save and re-enables its controls', async () => {
  const pending = deferred<boolean>();
  mock.method(reviewWorkspaceLibrary, 'put', () => pending.promise);
  const errors = mock.method(toast, 'error', () => undefined);
  const warn = mock.method(console, 'warn', () => undefined);
  const ui = render(<ReviewDecision cardKey="card-1" decision={DECISION} />);
  click(button(ui, 'Save decision'));
  await act(async () => { pending.reject(new Error('storage exploded')); await pending.promise.catch(() => undefined); });
  await settle();
  assert.equal(errors.mock.callCount(), 1, 'the person is told the decision was not saved');
  assert.ok(warn.mock.calls.some(call => String(call.arguments[1]).includes('storage exploded')), 'the failure is logged, not swallowed');
  assert.equal(button(ui, 'Save decision').disabled, false, 'a rejected save cannot leave the controls stuck');
});
