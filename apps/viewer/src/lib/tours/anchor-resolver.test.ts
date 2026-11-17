/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A step's panel is opened before its anchor is looked up (#5608). Skipping
 * a tour's own "open the panel" step used to leave the panel closed, and
 * every later step in it broke (the Compare tour's whole run in telemetry).
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspacePanelId } from '@/lib/panels/registry';
import { resolveAnchor } from './anchor-resolver.js';
import { TOUR_ANCHORS } from './anchors.js';
import type { TourStep, ViewerStoreApi } from './types.js';

const STEP: TourStep = {
  id: 'ab-picks',
  kind: 'passive',
  anchor: TOUR_ANCHORS.compareAb,
  panel: 'compare',
  title: 'A is old, B is new',
  body: 'body',
};

/** Store stub: `showWorkspacePanel` mounts the anchor, as opening the real panel does. */
function panelStore(detached: { floating?: boolean; popped?: boolean } = {}) {
  const shown: WorkspacePanelId[] = [];
  const state = {
    floatingPanels: detached.floating ? [{ id: 'compare' }] : [],
    poppedOutIds: detached.popped ? ['compare'] : [],
    sidebarHiddenIds: [],
    showWorkspacePanel: (id: WorkspacePanelId) => {
      shown.push(id);
      if (document.querySelector('[data-tour="compare-ab"]')) return;
      const el = document.createElement('div');
      el.setAttribute('data-tour', TOUR_ANCHORS.compareAb);
      document.body.appendChild(el);
    },
  };
  // Only the fields the resolver reads are stubbed.
  const store = { getState: () => state } as unknown as ViewerStoreApi;
  return { store, shown };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('resolveAnchor opens the step panel (#5608)', () => {
  it('opens a closed panel so its anchor can be found', async () => {
    const { store, shown } = panelStore();
    const res = await resolveAnchor(store, STEP, () => true);
    assert.deepEqual(shown, ['compare']);
    assert.ok(res.el, 'anchor resolved');
    assert.equal(res.redocked, false, 'opening a closed panel is not a re-dock');
  });

  it('leaves an already-open panel alone', async () => {
    const el = document.createElement('div');
    el.setAttribute('data-tour', TOUR_ANCHORS.compareAb);
    document.body.appendChild(el);
    const { store, shown } = panelStore();
    const res = await resolveAnchor(store, STEP, () => true);
    assert.deepEqual(shown, []);
    assert.equal(res.el, el);
  });

  it('still re-docks a popped-out panel and reports it', async () => {
    const { store, shown } = panelStore({ popped: true });
    const res = await resolveAnchor(store, STEP, () => true);
    assert.deepEqual(shown, ['compare']);
    assert.equal(res.redocked, true);
  });
});

it('slow deferred panel code does not consume the anchor deadline (#9634)', async () => {
  let ready!: () => void;
  const pending = new Promise<void>(resolve => { ready = resolve; });
  const { store } = panelStore();
  // Opening the host cannot mount the feature anchor until its chunk arrives.
  store.getState().showWorkspacePanel = () => undefined;
  const loading = resolveAnchor(store, { ...STEP, panel: 'lens' }, () => true, async () => pending);
  // Simulate a chunk taking longer than the complete anchor timeout without
  // a real network delay. Only after resolution should DOM polling begin.
  const original = performance.now.bind(performance);
  const before = Object.getOwnPropertyDescriptor(performance, 'now');
  Object.defineProperty(performance, 'now', { configurable: true, value: () => original() + 10_000 });
  try {
    const anchor = document.createElement('div');
    anchor.setAttribute('data-tour', TOUR_ANCHORS.compareAb);
    document.body.appendChild(anchor);
    ready();
    const result = await loading;
    assert.equal(result.el === anchor, true, 'a slow chunk still reaches the real anchor');
    assert.equal(result.reason, undefined);
  } finally {
    if (before) Object.defineProperty(performance, 'now', before);
    else Reflect.deleteProperty(performance, 'now');
  }
});

it('a cancelled step does not spotlight a panel when its deferred import finishes (#9634)', async () => {
  let ready!: () => void;
  let current = true;
  const pending = new Promise<void>(resolve => { ready = resolve; });
  const { store } = panelStore();
  const loading = resolveAnchor(store, { ...STEP, panel: 'bcf' }, () => current, async () => pending);
  current = false;
  ready();
  const result = await loading;
  assert.equal(result.el === null, true);
  assert.equal(result.reason, undefined, 'cancellation is not reported as a broken anchor');
});
