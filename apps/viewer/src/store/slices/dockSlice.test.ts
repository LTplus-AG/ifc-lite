/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createStore } from 'zustand/vanilla';
import { createDockSlice, type DockSlice } from './dockSlice.js';
import type { WorkspacePanelId } from '@/lib/panels/registry';

const makeStore = () => createStore<DockSlice>(createDockSlice);

describe('dockSlice (#1201)', () => {
  it('floats panels and z-orders by recency', () => {
    const s = makeStore();
    s.getState().floatPanel('compare');
    s.getState().floatPanel('properties');
    assert.deepStrictEqual(s.getState().floatingPanels.map((p) => p.id), ['compare', 'properties']);
    // Re-floating an open panel raises it to the front, not duplicates it.
    s.getState().floatPanel('compare');
    assert.deepStrictEqual(s.getState().floatingPanels.map((p) => p.id), ['properties', 'compare']);
    assert.strictEqual(s.getState().floatingPanels.filter((p) => p.id === 'compare').length, 1);
  });

  it('gives a new float sane default geometry (free, sized)', () => {
    const s = makeStore();
    s.getState().floatPanel('bcf');
    const p = s.getState().floatingPanels[0];
    assert.strictEqual(p.snap, 'free');
    assert.ok(p.w >= 260 && p.h >= 180);
  });

  it('snaps, resizes and closes a panel', () => {
    const s = makeStore();
    s.getState().floatPanel('ids');
    s.getState().snapFloatingPanel('ids', 'left');
    assert.strictEqual(s.getState().floatingPanels[0].snap, 'left');
    s.getState().setFloatingPanelRect('ids', { w: 500 });
    assert.strictEqual(s.getState().floatingPanels[0].w, 500);
    s.getState().closeFloatingPanel('ids');
    assert.strictEqual(s.getState().floatingPanels.length, 0);
  });

  it('brings a panel to the front', () => {
    const s = makeStore();
    const ids: WorkspacePanelId[] = ['compare', 'bcf', 'ids'];
    ids.forEach((id) => s.getState().floatPanel(id));
    s.getState().bringFloatingPanelToFront('compare');
    assert.strictEqual(s.getState().floatingPanels.at(-1)?.id, 'compare');
  });

  it('resetDockLayout drops every floating panel', () => {
    const s = makeStore();
    s.getState().floatPanel('lens');
    s.getState().floatPanel('clash');
    s.getState().resetDockLayout();
    assert.strictEqual(s.getState().floatingPanels.length, 0);
  });
});
