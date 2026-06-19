/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createStore } from 'zustand/vanilla';
import { createSidebarSlice, type SidebarSlice } from './sidebarSlice.js';
import { WORKSPACE_PANELS } from '@/lib/panels/registry';

const make = () => createStore<SidebarSlice>(createSidebarSlice);

describe('sidebarSlice (#1208)', () => {
  it('defaults to expanded, full order, nothing hidden, Information active', () => {
    const s = make().getState();
    assert.strictEqual(s.sidebarMode, 'expanded');
    assert.strictEqual(s.sidebarOrder.length, WORKSPACE_PANELS.length);
    assert.deepStrictEqual(s.sidebarHiddenIds, []);
    assert.strictEqual(s.sidebarActivePanel, 'properties');
    assert.deepStrictEqual(s.poppedOutIds, []);
  });

  it('toggles / cycles between expanded and collapsed (rail always visible)', () => {
    const s = make();
    s.getState().cycleSidebarMode();
    assert.strictEqual(s.getState().sidebarMode, 'collapsed');
    s.getState().cycleSidebarMode();
    assert.strictEqual(s.getState().sidebarMode, 'expanded');
    s.getState().toggleSidebar();
    assert.strictEqual(s.getState().sidebarMode, 'collapsed');
    s.getState().toggleSidebar();
    assert.strictEqual(s.getState().sidebarMode, 'expanded');
  });

  it('migrates a persisted/captured "hidden" mode to collapsed (rail never hides)', () => {
    const s = make();
    s.getState().applySidebarLayout({ mode: 'hidden' });
    assert.strictEqual(s.getState().sidebarMode, 'collapsed');
  });

  it('clamps the width to a sane range', () => {
    const s = make();
    s.getState().setSidebarWidthPct(999);
    assert.ok(s.getState().sidebarWidthPct <= 60);
    s.getState().setSidebarWidthPct(1);
    assert.ok(s.getState().sidebarWidthPct >= 14);
  });

  it('reorders a panel to the front', () => {
    const s = make();
    const third = s.getState().sidebarOrder[2];
    s.getState().reorderSidebarPanel(third, 0);
    assert.strictEqual(s.getState().sidebarOrder[0], third);
    assert.strictEqual(new Set(s.getState().sidebarOrder).size, WORKSPACE_PANELS.length);
  });

  it('hides / shows panels but never hides Information', () => {
    const s = make();
    s.getState().setPanelShownInSidebar('bcf', false);
    assert.ok(s.getState().sidebarHiddenIds.includes('bcf'));
    s.getState().setPanelShownInSidebar('bcf', true);
    assert.ok(!s.getState().sidebarHiddenIds.includes('bcf'));
    s.getState().setPanelShownInSidebar('properties', false);
    assert.ok(!s.getState().sidebarHiddenIds.includes('properties'));
  });

  it('tracks popped-out panels idempotently', () => {
    const s = make();
    s.getState().setPanelPoppedOut('clash', true);
    s.getState().setPanelPoppedOut('clash', true);
    assert.deepStrictEqual(s.getState().poppedOutIds, ['clash']);
    s.getState().setPanelPoppedOut('clash', false);
    assert.deepStrictEqual(s.getState().poppedOutIds, []);
  });

  it('serialize → apply round-trips a customized layout', () => {
    const s = make();
    s.getState().setSidebarMode('collapsed');
    s.getState().setSidebarWidthPct(33);
    s.getState().setPanelShownInSidebar('ids', false);
    s.getState().reorderSidebarPanel('extensions', 0);
    const snap = s.getState().serializeSidebarLayout();

    const s2 = make();
    s2.getState().applySidebarLayout(snap);
    assert.strictEqual(s2.getState().sidebarMode, 'collapsed');
    assert.strictEqual(Math.round(s2.getState().sidebarWidthPct), 33);
    assert.ok(s2.getState().sidebarHiddenIds.includes('ids'));
    assert.strictEqual(s2.getState().sidebarOrder[0], 'extensions');
  });

  it('applySidebarLayout tolerates garbage: bad mode/width fall back, order is normalized', () => {
    const s = make();
    s.getState().applySidebarLayout({
      mode: 'nope',
      widthPct: 'x',
      order: ['bcf', 'not-a-panel', 'bcf'],
      hiddenIds: ['properties', 'lens'],
    });
    assert.ok(['expanded', 'collapsed'].includes(s.getState().sidebarMode));
    assert.ok(Number.isFinite(s.getState().sidebarWidthPct));
    // order: bcf first, no dupes / unknowns, every registry panel present.
    assert.strictEqual(s.getState().sidebarOrder[0], 'bcf');
    assert.strictEqual(new Set(s.getState().sidebarOrder).size, WORKSPACE_PANELS.length);
    // Information is never hidden; a valid id is.
    assert.ok(!s.getState().sidebarHiddenIds.includes('properties'));
    assert.ok(s.getState().sidebarHiddenIds.includes('lens'));
  });

  it('resetSidebarLayout restores defaults', () => {
    const s = make();
    s.getState().setSidebarMode('collapsed');
    s.getState().setPanelShownInSidebar('bcf', false);
    s.getState().reorderSidebarPanel('extensions', 0);
    s.getState().resetSidebarLayout();
    assert.strictEqual(s.getState().sidebarMode, 'expanded');
    assert.deepStrictEqual(s.getState().sidebarHiddenIds, []);
    assert.strictEqual(s.getState().sidebarOrder[0], WORKSPACE_PANELS[0].id);
  });
});
