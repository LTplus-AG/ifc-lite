/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The compositor is the ONE writer from the overlay-layer registry into the
 * renderer channels, and it is mounted once by `ViewerLayout` rather than by
 * the panel that happens to own a layer (#3944). What that buys — and what
 * this pins — is that a layer registered while no Gantt panel is open still
 * reaches `hiddenEntities`, and that a user's own hide survives the layer's
 * removal.
 */
import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store/index.js';
import { render, cleanup } from '@/test/render.js';
import { useOverlayCompositor } from './useOverlayCompositor.js';

function Host() {
  useOverlayCompositor();
  return null;
}

describe('useOverlayCompositor as the single session writer', () => {
  afterEach(() => {
    cleanup();
    useViewerStore.setState({ hiddenEntities: new Set(), overlayLayers: new Map(), pendingColorUpdates: null });
  });

  it('hides what a registered layer asks for and restores it on removal, keeping a user-hidden id hidden', () => {
    useViewerStore.setState({ hiddenEntities: new Set([7]), overlayLayers: new Map() });
    render(<Host />);

    act(() => {
      useViewerStore.getState().registerOverlayLayer({
        id: 'charts',
        priority: 75,
        hiddenIds: new Set([7, 8, 9]),
        colorOverrides: new Map([[8, [1, 0, 0, 1]]]),
      });
    });
    const afterRegister = useViewerStore.getState();
    assert.deepEqual([...afterRegister.hiddenEntities].sort(), [7, 8, 9]);
    // Colour writes are one-shot; the compositor hands the composite to the
    // renderer sync and the store keeps the pending map until it is consumed.
    assert.deepEqual([...(afterRegister.pendingColorUpdates?.keys() ?? [])], [8]);

    act(() => {
      useViewerStore.getState().removeOverlayLayer('charts');
    });
    // 8 and 9 come back; 7 was the user's and stays hidden.
    assert.deepEqual([...useViewerStore.getState().hiddenEntities], [7]);
  });
});
