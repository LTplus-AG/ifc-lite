/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Point Clouds side panel's rail visibility (#5507).
 *
 * `PointCloudPanel` used to be a floating card mounted unconditionally
 * whenever `pointCloudAssetCount > 0` (`ViewportOverlays`'s
 * `PointCloudPanelMount`). Docked into the sidebar as the `pointclouds`
 * panel, its entry point is the ActivityBar rail — which must therefore
 * carry the same gating the floating card had: no icon (and so no way to
 * reach the panel) while no point cloud asset is loaded, same shape as the
 * Room icon's `isCollabEnabled()` gate right above it in the component.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { ActivityBar } from './ActivityBar';

function pointCloudsButton(container: HTMLElement): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('button')].find(
    (b) => b.getAttribute('aria-label') === 'Point Clouds',
  );
}

describe('ActivityBar — Point Clouds rail visibility (#5507)', () => {
  afterEach(() => {
    cleanup();
    useViewerStore.getState().setPointCloudAssetCount(0);
    useViewerStore.getState().showWorkspacePanel('properties');
  });

  it('shows no Point Clouds icon when no point cloud is loaded', () => {
    useViewerStore.getState().setPointCloudAssetCount(0);
    const container = render(<ActivityBar />);
    assert.equal(pointCloudsButton(container), undefined,
      'the rail must not offer a way to open the Point Clouds panel with nothing loaded');
  });

  it('shows the Point Clouds icon once a point cloud asset loads', () => {
    useViewerStore.getState().setPointCloudAssetCount(2);
    const container = render(<ActivityBar />);
    const button = pointCloudsButton(container);
    assert.ok(button, 'the rail must offer the Point Clouds icon once assets are loaded');
  });

  it('the Point Clouds icon docks the panel on click', () => {
    useViewerStore.getState().setPointCloudAssetCount(1);
    const container = render(<ActivityBar />);
    const button = pointCloudsButton(container);
    assert.ok(button);
    act(() => { button!.click(); });
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'pointclouds');
  });

  it('the icon disappears again once the last asset unloads', () => {
    useViewerStore.getState().setPointCloudAssetCount(1);
    const container = render(<ActivityBar />);
    assert.ok(pointCloudsButton(container));
    act(() => { useViewerStore.getState().setPointCloudAssetCount(0); });
    assert.equal(pointCloudsButton(container), undefined);
  });
});
