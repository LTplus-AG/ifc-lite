/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Point Clouds side panel remains reachable before an asset loads (#5873).
 *
 * The rail exposes every panel. With no point cloud asset, the panel explains
 * how to populate it rather than becoming unreachable.
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
    (b) => b.getAttribute('aria-label') === 'Point Cloud',
  );
}

describe('ActivityBar — Point Clouds rail reachability (#5873)', () => {
  afterEach(() => {
    cleanup();
    useViewerStore.getState().setPointCloudAssetCount(0);
    useViewerStore.getState().showWorkspacePanel('properties');
  });

  it('shows the Point Clouds icon when no point cloud is loaded', () => {
    useViewerStore.getState().setPointCloudAssetCount(0);
    const container = render(<ActivityBar />);
    assert.ok(pointCloudsButton(container),
      'the rail must offer every panel before its data is available');
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

  it('the icon stays available once the last asset unloads', () => {
    useViewerStore.getState().setPointCloudAssetCount(1);
    const container = render(<ActivityBar />);
    assert.ok(pointCloudsButton(container));
    act(() => { useViewerStore.getState().setPointCloudAssetCount(0); });
    assert.ok(pointCloudsButton(container));
  });
});
