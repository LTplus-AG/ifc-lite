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
    assert.equal(document.querySelector('[data-panel-id="sources"]'), null, 'a way in is not folded away');
  });

  it('keeps the whole rail once a model is loaded', () => {
    loaded();
    const root = render(<ActivityBar />);
    assert.equal(states(root).Lens, 'rest');
    assert.equal(root.querySelector('[data-rail-overflow]'), null);
  });
});
