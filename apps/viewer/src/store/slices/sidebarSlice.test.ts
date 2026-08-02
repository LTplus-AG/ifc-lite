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
    // order: Hierarchy is migrated to the top (#1267), then the persisted bcf,
    // no dupes / unknowns, every registry panel present.
    assert.strictEqual(s.getState().sidebarOrder[0], 'hierarchy');
    assert.strictEqual(s.getState().sidebarOrder[1], 'bcf');
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
    // Hierarchy (#1267) is the default top of the rail, even though it's the
    // last *registry* entry (so the Alt+1..0 mapping stays frozen).
    assert.strictEqual(s.getState().sidebarOrder[0], 'hierarchy');
  });
});

describe('sidebarSlice ordering (#1267)', () => {
  it('defaults Hierarchy to the top of the rail order', () => {
    const s = make();
    assert.strictEqual(s.getState().sidebarOrder[0], 'hierarchy');
  });

  it('keeps every registry panel present after reordering Hierarchy', () => {
    const s = make();
    const before = [...s.getState().sidebarOrder].sort();
    s.getState().reorderSidebarPanel('hierarchy', 5);
    const after = [...s.getState().sidebarOrder].sort();
    assert.deepStrictEqual(after, before);
    assert.strictEqual(s.getState().sidebarOrder.length, WORKSPACE_PANELS.length);
  });

  it('migrates a pre-#1267 saved order (no Hierarchy) by prepending it to the top', () => {
    const s = make();
    // An order persisted before Hierarchy existed in the registry.
    s.getState().applySidebarLayout({ order: ['properties', 'compare', 'bcf'] });
    assert.strictEqual(s.getState().sidebarOrder[0], 'hierarchy');
    assert.strictEqual(s.getState().sidebarOrder[1], 'properties');
    assert.strictEqual(new Set(s.getState().sidebarOrder).size, WORKSPACE_PANELS.length);
  });
});

describe('sidebarSlice docked split (#1266)', () => {
  it('sets a side panel as the lower split half', () => {
    const s = make();
    s.getState().setSidebarActivePanel('ids');
    s.getState().setSidebarSecondaryPanel('compare');
    assert.strictEqual(s.getState().sidebarSecondaryPanel, 'compare');
  });

  it('rejects non-side panels as the split half (bottom / left)', () => {
    const s = make();
    s.getState().setSidebarActivePanel('ids');
    s.getState().setSidebarSecondaryPanel('script'); // bottom strip
    assert.strictEqual(s.getState().sidebarSecondaryPanel, null);
    s.getState().setSidebarSecondaryPanel('hierarchy'); // left slot
    assert.strictEqual(s.getState().sidebarSecondaryPanel, null);
  });

  it('refuses to split a panel against itself', () => {
    const s = make();
    s.getState().setSidebarActivePanel('ids');
    s.getState().setSidebarSecondaryPanel('ids');
    assert.strictEqual(s.getState().sidebarSecondaryPanel, null);
  });

  it('collapses the split when the secondary is promoted to primary', () => {
    const s = make();
    s.getState().setSidebarActivePanel('ids');
    s.getState().setSidebarSecondaryPanel('compare');
    assert.strictEqual(s.getState().sidebarSecondaryPanel, 'compare');
    s.getState().setSidebarActivePanel('compare');
    assert.strictEqual(s.getState().sidebarActivePanel, 'compare');
    assert.strictEqual(s.getState().sidebarSecondaryPanel, null);
  });

  it('clamps the split ratio to [0.2, 0.8] and falls back on NaN', () => {
    const s = make();
    s.getState().setSidebarSplitRatio(0.05);
    assert.strictEqual(s.getState().sidebarSplitRatio, 0.2);
    s.getState().setSidebarSplitRatio(0.95);
    assert.strictEqual(s.getState().sidebarSplitRatio, 0.8);
    s.getState().setSidebarSplitRatio(0.42);
    assert.strictEqual(s.getState().sidebarSplitRatio, 0.42);
    s.getState().setSidebarSplitRatio(Number.NaN);
    assert.strictEqual(s.getState().sidebarSplitRatio, 0.5);
  });

  it('resetSidebarLayout drops the split back to a single panel', () => {
    const s = make();
    s.getState().setSidebarActivePanel('ids');
    s.getState().setSidebarSecondaryPanel('compare');
    s.getState().setSidebarSplitRatio(0.7);
    s.getState().resetSidebarLayout();
    assert.strictEqual(s.getState().sidebarSecondaryPanel, null);
    assert.strictEqual(s.getState().sidebarSplitRatio, 0.5);
  });
});
