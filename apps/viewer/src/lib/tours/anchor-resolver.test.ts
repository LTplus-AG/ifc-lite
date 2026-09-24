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
