/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section tool's UI loads when the tool is first opened (#7616): the HUD mounts without waiting
 * for it, the bar appears into the top-center region once its chunk has arrived, and opening the tool
 * again (the chunk is warm) mounts it in the same render, with no empty frame in between.
 *
 * This file must NOT import `@/test/section-tool-ready.js`: the chunk has to be unloaded when it starts.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { ViewportHud } from '../viewport-ui/hud/ViewportHud.js';
import { SceneOverlayRoot } from '../viewport-ui/scene';
import { ToolOverlays } from './ToolOverlays.js';

const bar = () => document.querySelector('[data-hud-region="top-center"] [data-tool-bar="section"]');
/** A boolean, not the node: a failing `assert.equal` on DOM elements walks their React fibers and never returns. */
const barShown = () => bar() !== null;

beforeEach(() => {
  useViewerStore.setState({
    activeTool: 'select',
    repositionOpen: false,
    cameraCallbacks: { projectToScreen: () => null, getViewpoint: () => null },
  } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
});
afterEach(() => {
  cleanup();
  useViewerStore.setState({ activeTool: 'select' });
});

/** Let the chunk load: the bar shows up, or the wait gives up and the assertion after it says so. */
async function untilBar(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 200 && !barShown(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe('the Section tool loads on first use (#7616)', () => {
  it('mounts the HUD at once, shows the bar when its chunk arrives, and shows it with no wait the next time', async () => {
    render(<ViewportHud />);
    render(<SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot>);

    act(() => useViewerStore.getState().setActiveTool('section'));
    assert.equal(barShown(), false, 'the first open does not wait for the chunk: nothing is blocked, the bar follows');

    await untilBar();
    assert.equal(barShown(), true, 'the bar is in the top-center region once the chunk has loaded');

    act(() => useViewerStore.getState().setActiveTool('select'));
    assert.equal(barShown(), false, 'closing the tool removes the bar');
    act(() => useViewerStore.getState().setActiveTool('section'));
    assert.equal(barShown(), true, 'opening it again mounts the bar in the same render');
  });
});
