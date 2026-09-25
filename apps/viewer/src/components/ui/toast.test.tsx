/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The toast stack must stay readable when something fails repeatedly (#5603):
 * a GPU device lost in a loop stacked 11 identical error toasts over the
 * Inspector on a phone. Identical messages merge with a count, at most three
 * toasts show, errors are announced assertively and stay until dismissed, and
 * both live regions are mounted before the first toast so it is announced.
 */

import '@/test/setup-dom.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Toaster, toast } from './toast';

let host: HTMLDivElement;
let root: Root;

/** Each toast is the row holding its dismiss button. */
function dismissButtons(): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss notification"]')];
}

function toastItems(): HTMLElement[] {
  return dismissButtons().map((button) => button.parentElement!);
}

describe('Toaster (#5603)', () => {
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(<Toaster />));
  });

  afterEach(() => {
    // The store is module-level: clear what this test left so the next starts empty.
    for (const button of dismissButtons()) act(() => button.click());
    act(() => root.unmount());
    host.remove();
  });

  it('keeps both live regions mounted before the first toast', () => {
    assert.equal(toastItems().length, 0);
    assert.ok(host.querySelector('[role="status"][aria-live="polite"]'), 'polite region missing');
    assert.ok(host.querySelector('[role="alert"]'), 'alert region missing');
  });

  it('merges five identical errors into one toast counted ×5', () => {
    for (let i = 0; i < 5; i++) act(() => toast.error('GPU device lost'));
    const items = toastItems();
    assert.equal(items.length, 1);
    assert.match(items[0]!.textContent ?? '', /GPU device lost/);
    assert.match(items[0]!.textContent ?? '', /×5/);
  });

  it('shows at most three toasts; a fourth distinct one evicts the oldest', () => {
    act(() => toast.info('first'));
    act(() => toast.info('second'));
    act(() => toast.info('third'));
    act(() => toast.info('fourth'));
    const texts = toastItems().map((item) => item.textContent ?? '');
    assert.equal(texts.length, 3);
    assert.ok(!texts.some((text) => text.includes('first')), 'oldest toast was not evicted');
    assert.ok(texts.some((text) => text.includes('fourth')));
  });

  it('evicts transient toasts before an error, so newer successes cannot push it off', () => {
    act(() => toast.error('Export failed'));
    act(() => toast.success('one'));
    act(() => toast.success('two'));
    act(() => toast.success('three'));
    const texts = toastItems().map((item) => item.textContent ?? '');
    assert.equal(texts.length, 3);
    assert.ok(texts.some((text) => text.includes('Export failed')), 'the error was evicted by newer successes');
    assert.ok(!texts.some((text) => text.includes('one')), 'the oldest success should have gone first');
  });

  it('evicts the oldest error only when every visible toast is an error', () => {
    for (const message of ['e1', 'e2', 'e3', 'e4']) act(() => toast.error(message));
    const texts = toastItems().map((item) => item.textContent ?? '');
    assert.equal(texts.length, 3);
    assert.ok(!texts.some((text) => text.includes('e1')));
  });

  it('gives the dismiss button an accessible name', () => {
    act(() => toast.success('Exported 42 entities'));
    const [button] = dismissButtons();
    assert.equal(button?.getAttribute('aria-label'), 'Dismiss notification');
  });

  it('keeps a success action until used, then dismisses its toast (#5827)', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let opened = 0;
    act(() => toast.success('Topic created', { label: 'Open BCF', onClick: () => { opened++; } }));
    act(() => t.mock.timers.tick(60_000));
    const action = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Open BCF');
    assert.ok(action, 'the action is visible and named');
    act(() => action.click());
    assert.equal(opened, 1);
    assert.equal(toastItems().length, 0);
  });

  it('puts errors in the role=alert region and other toasts in the polite one', () => {
    act(() => toast.error('Export failed'));
    act(() => toast.success('Saved'));
    const error = toastItems().find((item) => item.textContent?.includes('Export failed'));
    const success = toastItems().find((item) => item.textContent?.includes('Saved'));
    assert.equal(error?.closest('[role]')?.getAttribute('role'), 'alert');
    assert.equal(success?.closest('[role]')?.getAttribute('role'), 'status');
  });

  it('anchors to the nearest positioned ancestor with variant="absolute" (#5504)', () => {
    // Own root/container: `variant="absolute"` is what lets `ViewportContainer`
    // anchor the stack to the viewport panel instead of the whole window.
    const container = document.createElement('div');
    document.body.appendChild(container);
    const localRoot = createRoot(container);
    act(() => localRoot.render(<Toaster variant="absolute" />));
    const stack = container.firstElementChild as HTMLElement;
    assert.ok(stack.className.includes('absolute'), 'expected the "absolute" utility class');
    assert.ok(!stack.className.includes('fixed'), 'must not also carry "fixed"');
    act(() => localRoot.unmount());
    container.remove();
  });

  it('keeps an error until it is dismissed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    act(() => toast.error('Export failed'));
    act(() => toast.success('Saved'));
    act(() => t.mock.timers.tick(60_000));
    const texts = toastItems().map((item) => item.textContent ?? '');
    assert.equal(texts.length, 1);
    assert.match(texts[0]!, /Export failed/);
  });
});
