/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { act } from 'react';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { render, click, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { useTourStore } from '@/lib/tours/tour-store';
import { GitHubStarPrompt } from './GitHubStarPrompt';

const KEY = 'ifc-lite:github-star';
const original = useViewerStore.getState();
let now = 100;
let callbacks: Set<() => void>;
const invitation = () => document.querySelector('aside[aria-label="Enjoying IFC Lite?"]');
function tick(seconds: number, interact = true) {
  for (let i = 0; i < seconds; i++) {
    act(() => {
      if (interact && i % 10 === 0) window.dispatchEvent(new window.Event('pointermove'));
      now += 1000;
      for (const callback of callbacks) callback();
    });
  }
}
async function qualify() { tick(126); await act(async () => {}); }

// #8806: exercise the mounted card, real event handlers and durable impression.
describe('GitHub star invitation (#8806)', () => {
  beforeEach(() => {
    now = 100;
    callbacks = new Set();
    localStorage.clear();
    localStorage.setItem(KEY, String(Date.now() - 2 * 86_400_000));
    useViewerStore.setState({ ...fixtureModels(fixtureModel('star')), loading: false,
      geometryStreamingActive: false, error: null, isMobile: false, activeTool: 'select' });
    mock.method(performance, 'now', () => now);
    mock.method(document, 'hasFocus', () => true);
    mock.getter(document, 'visibilityState', () => 'visible');
    mock.method(window, 'setInterval', (callback: () => void) => { callbacks.add(callback); return callback; });
    mock.method(window, 'clearInterval', (callback: () => void) => callbacks.delete(callback));
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: async (_key: string, callback: () => void) => callback(),
    } });
  });
  afterEach(() => { cleanup(); mock.restoreAll(); localStorage.clear(); useViewerStore.setState(original); useTourStore.setState({ status: 'idle' }); });

  it('never prompts on the first visit or on an immediate remount', async () => {
    localStorage.clear();
    render(<GitHubStarPrompt />); await qualify();
    assert.equal(invitation(), null);
    cleanup(); render(<GitHubStarPrompt />); await qualify();
    assert.equal(invitation(), null);
  });
  it('waits for active time and a quiet moment, then persists before dismissal', async () => {
    render(<GitHubStarPrompt />);
    tick(119); assert.equal(invitation(), null);
    tick(7); await act(async () => {});
    assert.ok(invitation()); assert.equal(localStorage.getItem(KEY), 'shown');
    click(document.querySelector('button[aria-label="Dismiss GitHub invitation permanently"]')!);
    assert.equal(invitation(), null);
    cleanup(); render(<GitHubStarPrompt />); await qualify();
    assert.equal(invitation(), null);
  });
  it('never counts unattended time', async () => {
    render(<GitHubStarPrompt />); tick(300, false); await act(async () => {});
    assert.equal(invitation(), null);
  });
  for (const state of [{ loading: true }, { geometryStreamingActive: true }, { error: 'failed' },
    { isMobile: true }, { activeTool: 'measure' as const }, { models: new Map() }]) {
    it(`suppresses in viewer state ${JSON.stringify(state)}`, async () => {
      useViewerStore.setState(state); render(<GitHubStarPrompt />); await qualify();
      assert.equal(invitation(), null);
    });
  }
  it('defers for dialogs and notifications without consuming the invitation', async () => {
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); document.body.append(dialog);
    render(<GitHubStarPrompt />); await qualify(); assert.equal(invitation(), null);
    dialog.remove();
    const toast = document.createElement('div'); toast.dataset.toastSeq = '1'; document.body.append(toast);
    await qualify(); assert.equal(invitation(), null); toast.remove();
    await qualify(); assert.ok(invitation());
  });
  it('does not show during a held pointer gesture', async () => {
    render(<GitHubStarPrompt />); window.dispatchEvent(new window.Event('pointerdown'));
    await qualify(); assert.equal(invitation(), null);
    window.dispatchEvent(new window.Event('pointerup')); tick(6, false); await act(async () => {});
    assert.ok(invitation());
  });
  it('times out once, but pauses while keyboard focus is inside', async () => {
    render(<GitHubStarPrompt />); await qualify();
    const link = document.querySelector<HTMLAnchorElement>('aside a')!;
    assert.equal(link.href, 'https://github.com/LTplus-AG/ifc-lite');
    assert.equal(link.target, '_blank'); assert.equal(link.rel, 'noopener noreferrer');
    act(() => link.focus()); tick(30); assert.ok(invitation());
    act(() => link.blur()); tick(21); assert.equal(invitation(), null);
    cleanup(); render(<GitHubStarPrompt />); await qualify(); assert.equal(invitation(), null);
  });
  it('suppresses corrupt preferences and missing cross-tab locking', async () => {
    localStorage.setItem(KEY, 'broken'); render(<GitHubStarPrompt />); await qualify();
    assert.equal(invitation(), null); cleanup();
    localStorage.setItem(KEY, String(Date.now() - 2 * 86_400_000));
    Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    render(<GitHubStarPrompt />); await qualify(); assert.equal(invitation(), null);
  });
  it('hides if another tab consumes the invitation', async () => {
    render(<GitHubStarPrompt />); await qualify(); assert.ok(invitation());
    act(() => window.dispatchEvent(new window.StorageEvent('storage', { key: KEY, newValue: 'shown' })));
    assert.equal(invitation(), null);
  });
  it('does not count hidden tabs or an active tour', async () => {
    mock.getter(document, 'visibilityState', () => 'hidden');
    render(<GitHubStarPrompt />); await qualify(); assert.equal(invitation(), null);
    mock.getter(document, 'visibilityState', () => 'visible');
    useTourStore.setState({ status: 'running' });
    await qualify(); assert.equal(invitation(), null);
  });
  it('fails closed when reading or persisting storage throws', async () => {
    mock.method(console, 'warn', () => {});
    const read = mock.method(localStorage, 'getItem', () => { throw new Error('blocked'); });
    render(<GitHubStarPrompt />); await qualify(); assert.equal(invitation(), null);
    cleanup(); read.mock.restore();
    mock.method(localStorage, 'setItem', () => { throw new Error('quota'); });
    render(<GitHubStarPrompt />); await qualify(); assert.equal(invitation(), null);
  });
  it('rechecks quiet eligibility after waiting for a competing tab lock', async () => {
    let release: (() => void) | undefined;
    Object.defineProperty(navigator, 'locks', { configurable: true, value: {
      request: (_key: string, callback: () => void) => new Promise<void>((resolve) => {
        release = () => { callback(); resolve(); };
      }),
    } });
    render(<GitHubStarPrompt />); await qualify(); assert.equal(invitation(), null);
    window.dispatchEvent(new window.Event('pointermove'));
    await act(async () => { release?.(); });
    assert.equal(invitation(), null); assert.notEqual(localStorage.getItem(KEY), 'shown');
  });

});
