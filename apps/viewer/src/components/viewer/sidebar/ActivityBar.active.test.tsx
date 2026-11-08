/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The activity rail carries exactly one active item: the panel the right
 * pane actually shows (#8802 R1). Panels docked in another region (Hierarchy
 * on the left, a bottom-dock panel) read as "open", never as a second active
 * item. An empty viewer moves model-dependent panels into More (#8802 R6).
 */

import '@/test/setup-dom.js';
import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { ActivityBar } from './ActivityBar';

const original = useViewerStore.getState();
after(() => { useViewerStore.setState(original, true); });

const states = (root: HTMLElement) => Object.fromEntries(
  [...root.querySelectorAll<HTMLElement>('[data-rail-state]')].map((b) => [b.getAttribute('aria-label'), b.dataset.railState]),
);
const active = (root: HTMLElement) => Object.entries(states(root)).filter(([, s]) => s === 'active').map(([label]) => label);

function loaded(): void {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('m')), sidebarMode: 'expanded', leftPanelCollapsed: false });
}

describe('activity rail active state (#8802 R1)', () => {
  afterEach(() => {
    cleanup();
    useViewerStore.setState(original, true);
  });

  it('marks only the right-pane panel active while Hierarchy and a bottom panel are open elsewhere', () => {
    loaded();
    act(() => {
      useViewerStore.getState().showWorkspacePanel('properties');
      useViewerStore.getState().setListPanelVisible(true);
    });
    const root = render(<ActivityBar />);
    assert.deepEqual(active(root), ['Properties']);
    assert.equal(states(root).Hierarchy, 'open', 'the left-docked Hierarchy reads as open, not active');
    assert.equal(states(root).Lists, 'open', 'the bottom-docked Lists reads as open, not active');
  });

  it('follows the right pane when it shows a left-region panel (Hierarchy in the pane)', () => {
    loaded();
    act(() => { useViewerStore.setState({ sidebarActivePanel: 'hierarchy' }); });
    const root = render(<ActivityBar />);
    assert.deepEqual(active(root), ['Hierarchy']);
  });

  it('shows no active item while the right pane is collapsed to the rail', () => {
    loaded();
    act(() => { useViewerStore.setState({ sidebarMode: 'collapsed' }); });
    const root = render(<ActivityBar />);
    assert.deepEqual(active(root), []);
  });

  it('moves model-dependent panels into More on an empty viewer and leaves ways in on the rail (#8802 R6)', () => {
    useViewerStore.setState({ models: new Map(), ifcDataStore: null, loading: false });
    const root = render(<ActivityBar />);
    const s = states(root);
    assert.equal(s.Lens, undefined, 'a panel that needs a model waits in More, off the rail');
    assert.equal(s['Cloud Sources'], 'rest', 'a way in stays on the rail at full ink');
    const more = root.querySelector<HTMLButtonElement>('[data-rail-overflow]');
    assert.ok(more, 'the waiting panels stay reachable through More');
    act(() => {
      more.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    });
    act(() => { more.click(); });
    const lens = document.querySelector<HTMLElement>('[data-panel-id="lens"]');
    assert.ok(lens, 'Lens is listed in More');
    assert.ok(lens.hasAttribute('data-needs-model'), 'and says it needs a model');
    // Booleans as `actual`: a failing assert inspects it, and a jsdom node exhausts the heap.
    assert.equal(document.querySelector('[data-panel-id="sources"]') !== null, false, 'a way in is not folded away');
  });

  it('keeps Hierarchy (left slot) and Lists (bottom strip) on a short rail while they are open (#9236)', () => {
    // An empty viewer with the start fold lifted: Hierarchy open on the left,
    // Lists open in the bottom strip, both last in rail order.
    const state = useViewerStore.getState();
    const order = [...state.sidebarOrder.filter((id) => id !== 'hierarchy' && id !== 'lists'), 'hierarchy', 'lists'] as typeof state.sidebarOrder;
    useViewerStore.setState({
      models: new Map(), ifcDataStore: null, loading: false, sidebarOrder: order, sidebarHiddenIds: [],
      leftPanelCollapsed: false, startFoldLifted: { left: true, right: true },
    });
    act(() => { useViewerStore.getState().setListPanelVisible(true); });

    // A short rail: six icon rows, far fewer than the panels on offer but room
    // for the three open ones and their group dividers beside More. jsdom has
    // no layout, so the icon list reports this height to the rail's read.
    const SHORT = 6 * 38 + 14;
    const RealObserver = globalThis.ResizeObserver;
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.parentElement?.hasAttribute('data-activity-bar') && this === this.parentElement.firstElementChild ? SHORT : 0; },
    });
    try {
      const root = render(<ActivityBar />);
      const s = states(root);
      assert.ok(root.querySelector('[data-rail-overflow]'), 'the short rail overflows into More');
      assert.equal(s.Hierarchy, 'open', 'open Hierarchy keeps its rail icon');
      assert.equal(s.Lists, 'open', 'open Lists keeps its rail icon');
    } finally {
      globalThis.ResizeObserver = RealObserver;
      if (height) Object.defineProperty(HTMLElement.prototype, 'clientHeight', height);
    }
  });

  it('lets panels left in a collapsed sidebar wait in More once the last model goes (#9236 review)', () => {
    // Lens active with Charts in the split, then the sidebar is collapsed and
    // the last model removed. SidebarDock draws neither, so neither is pinned.
    useViewerStore.setState({
      models: new Map(), ifcDataStore: null, loading: false, sidebarHiddenIds: [],
      sidebarMode: 'collapsed', sidebarActivePanel: 'lens', sidebarSecondaryPanel: 'charts',
      startFoldLifted: { left: true, right: true },
    });
    const root = render(<ActivityBar />);
    const s = states(root);
    assert.equal(s.Lens, undefined, 'Lens is not drawn, so it waits in More');
    const more = root.querySelector<HTMLButtonElement>('[data-rail-overflow]');
    assert.ok(more);
    act(() => {
      more.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    });
    act(() => { more.click(); });
    for (const id of ['lens', 'charts']) {
      const row = document.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);
      assert.equal(row !== null && row.hasAttribute('data-needs-model'), true, `${id} waits in More, marked as needing a model`);
    }
  });

  it('keeps the whole rail once a model is loaded', () => {
    loaded();
    const root = render(<ActivityBar />);
    assert.equal(states(root).Lens, 'rest');
    assert.equal(root.querySelector('[data-rail-overflow]') !== null, false, 'no More with a loaded model and room');
  });
});
