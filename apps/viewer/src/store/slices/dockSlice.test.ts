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

  it('keeps a re-floated panel exactly where the user left it', () => {
    // github.com/LTplus-AG/ifc-lite/issues/2765: re-floating an already-open
    // panel raises it and MUST NOT reset its geometry. The order assertion
    // above passes either way, so resetting x/y/w/h/snap on every raise (which
    // happens on pointer-down) went unnoticed: the panel would jump back to
    // its default position whenever it was clicked.
    const s = makeStore();
    s.getState().floatPanel('compare');
    s.getState().setFloatingPanelRect('compare', { x: 120, y: 340, w: 500, h: 410 });
    s.getState().snapFloatingPanel('compare', 'left');

    s.getState().floatPanel('compare');

    const p = s.getState().floatingPanels.find((panel) => panel.id === 'compare');
    assert.deepStrictEqual(
      { x: p?.x, y: p?.y, w: p?.w, h: p?.h, snap: p?.snap },
      { x: 120, y: 340, w: 500, h: 410, snap: 'left' },
    );
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

  it('is a no-op (array identity preserved) when the panel is already on top', () => {
    // Non-default state: two panels floating, target already at the front.
    // A mutant that always rebuilds+persists on every call passes the
    // "raises it" test above (order is unaffected either way) but would
    // still trigger an unconditional localStorage write on every
    // pointer-down, even when nothing about the order changed.
    const s = makeStore();
    s.getState().floatPanel('bcf');
    s.getState().floatPanel('compare');
    const before = s.getState().floatingPanels;

    s.getState().bringFloatingPanelToFront('compare');

    assert.strictEqual(s.getState().floatingPanels, before, 'already-on-top must not allocate a new array');
  });

  it('does nothing when the given id is not currently floating', () => {
    // Guards against pushing an `undefined` entry onto floatingPanels when
    // `find` misses — a real crash risk in the renderer, not just a no-op.
    const s = makeStore();
    s.getState().floatPanel('bcf');
    const before = s.getState().floatingPanels;

    s.getState().bringFloatingPanelToFront('compare');

    assert.strictEqual(s.getState().floatingPanels, before);
    assert.ok(s.getState().floatingPanels.every((p) => p !== undefined && typeof p.id === 'string'));
  });

  it('resetDockLayout drops every floating panel', () => {
    const s = makeStore();
    s.getState().floatPanel('lens');
    s.getState().floatPanel('clash');
    s.getState().resetDockLayout();
    assert.strictEqual(s.getState().floatingPanels.length, 0);
  });
});
