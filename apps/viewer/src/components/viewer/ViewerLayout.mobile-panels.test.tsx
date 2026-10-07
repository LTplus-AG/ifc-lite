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
import { cleanup, click, render } from '@/test/render.js';
import { renderViewerLayout } from '@/test/viewer-layout-harness.js';
import { useViewerStore } from '@/store';
import type { FederatedModel } from '@/store/types';
import { getPanelDef, type WorkspacePanelId } from '@/lib/panels/registry';
import { englishCatalogue as en } from '@/i18n/en';
import { activeBottomPanel } from '@/lib/panels/bottom-panels';
import { resolveMobileSheet } from '@/lib/panels/mobileSheet';
import { isCollabEnabled } from '@/lib/collab/config';

const model: FederatedModel = {
  id: 'm1', name: 'm1.ifc', ifcDataStore: null, geometryResult: null, visible: true, collapsed: false,
  schemaVersion: 'IFC4', loadedAt: 1, fileSize: 3, idOffset: 0, maxExpressId: 0,
};

const ORIGINAL_WIDTH = window.innerWidth;

function expectedRailIds(): WorkspacePanelId[] {
  const { sidebarOrder, sidebarHiddenIds } = useViewerStore.getState();
  return sidebarOrder.filter((id) =>
    (!sidebarHiddenIds.includes(id) || id === 'properties') &&
    (id !== 'collab' || isCollabEnabled()));
}

function panelName(id: WorkspacePanelId): string {
  const value = en[getPanelDef(id)!.titleKey];
  if (typeof value !== 'string') throw new Error(`Panel ${id} has no text title`);
  return value;
}

function listItem(container: HTMLElement, id: WorkspacePanelId): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('li > button')]
    .find((item) => item.textContent?.trim() === panelName(id));
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
  it('#5873 keeps Point Cloud reachable before any scan is loaded', async () => {
    act(() => useViewerStore.getState().setPointCloudAssetCount(0));
    const { MobilePanelLauncher } = await import('./MobilePanelLauncher.js');
    const container = render(<MobilePanelLauncher bottomInset={0} />);
    openList(container);
    const item = listItem(container, 'pointclouds');
    assert.ok(item, 'the empty Point Cloud panel must remain reachable');
    click(item);
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'pointclouds');
    assert.equal(useViewerStore.getState().rightPanelCollapsed, false);
  });

  it('lists every panel the rail offers and opens each in its mobile home', async () => {
    // This assertion must run before loading the new launcher: when production
    // is reverted, the mounted viewer should fail for the missing entry point.
    const viewer = renderViewerLayout();
    assert.ok(button(viewer, 'Open the panel list'), 'mobile has no panel-list entry point');
    cleanup();
    const { MobilePanelLauncher } = await import('./MobilePanelLauncher.js');
    // Mount the real launcher without heavyweight panel bodies: a few panels
    // start remote data requests when their body mounts, which this routing
    // assertion does not need. The tests below mount the full layout.
    const container = render(<MobilePanelLauncher bottomInset={0} />);
    const expected = expectedRailIds();
    assert.ok(expected.length > 10, `the rail should offer many panels, got ${expected.length}`);
    openList(container);
    assert.deepEqual(
      [...container.querySelectorAll<HTMLButtonElement>('li > button')].map((item) => item.textContent?.trim()),
      expected.map(panelName),
      'the mobile list must match the rail exactly, once per panel and in its order',
    );
    for (const [index, id] of expected.entries()) {
      if (index > 0) openList(container);
      const item = listItem(container, id);
      assert.ok(item, `rail panel ${id} is unreachable on mobile`);
      click(item);
      const state = useViewerStore.getState();
      if (getPanelDef(id)!.region === 'left') {
        assert.equal(state.leftPanelCollapsed, false, `left panel ${id} did not open`);
      } else {
        assert.equal(state.rightPanelCollapsed, false, `panel ${id} did not open its sheet`);
        assert.deepEqual(resolveMobileSheet({
          hasAnalysisExtension: false,
          bottomPanel: activeBottomPanel(state),
          sidebarActivePanel: state.sidebarActivePanel,
        }), { kind: 'panel', id }, `panel ${id} did not occupy the mobile sheet`);
      }
      act(() => useViewerStore.setState({ leftPanelCollapsed: true, rightPanelCollapsed: true }));
    }
  });

  it('a tap opens a side panel in the mobile sheet', () => {
    const container = renderViewerLayout();
    openList(container);
    click(listItem(container, 'clash')!);
    const s = useViewerStore.getState();
    assert.equal(s.rightPanelCollapsed, false, 'the sheet did not open');
    assert.equal(s.sidebarActivePanel, 'clash');
    assert.equal(activeBottomPanel(s), null);
  });

  it('a tap opens a bottom-strip panel, and a later side panel closes it', () => {
    const container = renderViewerLayout();
    openList(container);
    click(listItem(container, 'lists')!);
    assert.equal(activeBottomPanel(useViewerStore.getState()), 'lists');
    assert.equal(useViewerStore.getState().rightPanelCollapsed, false);
    // Dismissed by the backdrop, which leaves the bottom flag set.
    act(() => useViewerStore.setState({ rightPanelCollapsed: true }));
    openList(container);
    click(listItem(container, 'bcf')!);
    assert.equal(activeBottomPanel(useViewerStore.getState()), null, 'the stale bottom panel would cover BCF');
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'bcf');
  });

  it('the direct Properties button clears a dismissed bottom panel before reopening the sheet', () => {
    const container = renderViewerLayout();
    openList(container);
    click(listItem(container, 'lists')!);
    assert.equal(activeBottomPanel(useViewerStore.getState()), 'lists');
    const backdrop = button(container, 'Close panels');
    assert.ok(backdrop);
    click(backdrop);
    assert.equal(useViewerStore.getState().rightPanelCollapsed, true);
    assert.equal(activeBottomPanel(useViewerStore.getState()), 'lists', 'backdrop leaves the bottom flag set');

    click(button(container, 'Open Properties')!);
    const s = useViewerStore.getState();
    assert.equal(s.rightPanelCollapsed, false);
    assert.equal(s.sidebarActivePanel, 'properties');
    assert.equal(activeBottomPanel(s), null, 'the stale Lists flag would hide Properties');
  });

  it('a tap on Hierarchy opens the left sheet', () => {
    const container = renderViewerLayout();
    openList(container);
    click(listItem(container, 'hierarchy')!);
    assert.equal(useViewerStore.getState().leftPanelCollapsed, false);
  });
});
