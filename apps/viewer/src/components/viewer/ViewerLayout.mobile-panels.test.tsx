/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5853: every panel the rail offers is reachable on a phone.
 *
 * Mobile has no rail, and it offered only two floating buttons, Hierarchy and
 * Properties. The Panels button now opens a sheet listing the rail's panels;
 * a tap opens that panel where the mobile sheet shows it.
 *
 * Renders the real `ViewerLayout` at phone width with a model loaded. The
 * expected list is derived here from the store and the registry, the same
 * inputs the rail filters, not from the code under test.
 */

import '@/test/setup-dom.js';
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-test';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click } from '@/test/render.js';
import { renderViewerLayout } from '@/test/viewer-layout-harness.js';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { getPanelDef, type WorkspacePanelId } from '@/lib/panels/registry';
import { activeBottomPanel } from '@/lib/panels/bottom-panels';
import { isCollabEnabled } from '@/lib/collab/config';

const model: FederatedModel = {
  id: 'm1', name: 'm1.ifc', ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
  schemaVersion: 'IFC4', loadedAt: 1, fileSize: 3, idOffset: 0, maxExpressId: 0,
};

const ORIGINAL_WIDTH = window.innerWidth;

function expectedRailIds(): WorkspacePanelId[] {
  const { sidebarOrder, sidebarHiddenIds, pointCloudAssetCount } = useViewerStore.getState();
  return sidebarOrder.filter((id) =>
    (!sidebarHiddenIds.includes(id) || id === 'properties') &&
    (id !== 'collab' || isCollabEnabled()) &&
    (id !== 'pointclouds' || pointCloudAssetCount > 0));
}

function button(container: HTMLElement, name: string): HTMLButtonElement | undefined {
  return [...container.ownerDocument.querySelectorAll<HTMLButtonElement>('button')]
    .find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name);
}

function openList(container: HTMLElement): void {
  const launcher = button(container, 'Open the panel list');
  assert.ok(launcher, 'mobile has no way to reach the other panels');
  click(launcher);
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  useViewerStore.setState({ models: new Map([['m1', model]]), leftPanelCollapsed: true, rightPanelCollapsed: true });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: ORIGINAL_WIDTH });
  useViewerStore.setState({ models: new Map(), isMobile: false, leftPanelCollapsed: true, rightPanelCollapsed: true });
});

describe('mobile Panels sheet (#5853)', () => {
  it('lists every panel the rail offers', () => {
    const container = renderViewerLayout();
    openList(container);
    const expected = expectedRailIds();
    assert.ok(expected.length > 10, `the rail should offer many panels, got ${expected.length}`);
    const missing = expected.filter((id) => !button(container, getPanelDef(id)!.title));
    assert.deepEqual(missing, [], 'these rail panels are unreachable on mobile');
  });

  it('a tap opens a side panel in the mobile sheet', () => {
    const container = renderViewerLayout();
    openList(container);
    click(button(container, getPanelDef('clash')!.title)!);
    const s = useViewerStore.getState();
    assert.equal(s.rightPanelCollapsed, false, 'the sheet did not open');
    assert.equal(s.sidebarActivePanel, 'clash');
    assert.equal(activeBottomPanel(s), null);
  });

  it('a tap opens a bottom-strip panel, and a later side panel closes it', () => {
    const container = renderViewerLayout();
    openList(container);
    click(button(container, getPanelDef('lists')!.title)!);
    assert.equal(activeBottomPanel(useViewerStore.getState()), 'lists');
    assert.equal(useViewerStore.getState().rightPanelCollapsed, false);
    // Dismissed by the backdrop, which leaves the bottom flag set.
    act(() => useViewerStore.setState({ rightPanelCollapsed: true }));
    openList(container);
    click(button(container, getPanelDef('bcf')!.title)!);
    assert.equal(activeBottomPanel(useViewerStore.getState()), null, 'the stale bottom panel would cover BCF');
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'bcf');
  });

  it('a tap on Hierarchy opens the left sheet', () => {
    const container = renderViewerLayout();
    openList(container);
    click(button(container, getPanelDef('hierarchy')!.title)!);
    assert.equal(useViewerStore.getState().leftPanelCollapsed, false);
  });
});
