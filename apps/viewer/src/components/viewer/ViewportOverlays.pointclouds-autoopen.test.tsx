/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Auto-opening the `pointclouds` side panel the first time a point cloud
 * loads (#5507) — the docked-panel replacement for the old floating
 * `PointCloudPanel` card, which simply rendered unconditionally whenever
 * `pointCloudAssetCount > 0` and so needed no explicit "surface me" step.
 *
 * The effect lives in `ViewportOverlays` (always mounted while the viewport
 * is up) and fires once per "0 -> some assets" transition, mirroring the
 * Layers panel's one-time introduction (`useIfcFederation.ts`, #1717) but
 * without the `localStorage` gate — this is a live scene-state transition,
 * not a first-ever-seen intro banner, so it can and should fire again the
 * next time a point cloud session starts from empty.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useViewerStore } from '@/store';
import { ViewportOverlays } from './ViewportOverlays';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];
function render(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <TooltipProvider>
        <ViewportOverlays hideViewCube hideAxis hideScale />
      </TooltipProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}
function unmountAll(): void {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
}

describe('ViewportOverlays — auto-open the Point Clouds panel (#5507)', () => {
  afterEach(() => {
    unmountAll();
    useViewerStore.getState().setPointCloudAssetCount(0);
    useViewerStore.getState().showWorkspacePanel('properties');
  });

  it('does not open the panel while no point cloud is loaded', () => {
    useViewerStore.setState({ pointCloudAssetCount: 0 });
    render();
    assert.notEqual(useViewerStore.getState().sidebarActivePanel, 'pointclouds');
  });

  it('docks the panel the first time a point cloud loads', () => {
    useViewerStore.setState({ pointCloudAssetCount: 0 });
    render();
    act(() => { useViewerStore.getState().setPointCloudAssetCount(3); });
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'pointclouds');
  });

  it('does not fight the user: switching away stays away while assets stay loaded', () => {
    useViewerStore.setState({ pointCloudAssetCount: 0 });
    render();
    act(() => { useViewerStore.getState().setPointCloudAssetCount(1); });
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'pointclouds');
    act(() => { useViewerStore.getState().showWorkspacePanel('properties'); });
    // Asset count merely changing (not a 0 -> N transition) must not re-open it.
    act(() => { useViewerStore.getState().setPointCloudAssetCount(2); });
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'properties');
  });

  it('re-opens on the next 0 -> N transition after all assets unload', () => {
    useViewerStore.setState({ pointCloudAssetCount: 0 });
    render();
    act(() => { useViewerStore.getState().setPointCloudAssetCount(1); });
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'pointclouds');
    act(() => { useViewerStore.getState().showWorkspacePanel('properties'); });
    act(() => { useViewerStore.getState().setPointCloudAssetCount(0); });
    act(() => { useViewerStore.getState().setPointCloudAssetCount(1); });
    assert.equal(useViewerStore.getState().sidebarActivePanel, 'pointclouds');
  });
});
