/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ToolOverlays` places the active tool's `TOOL_HUD` row through the HUD
 * (#5503): the bar lands in the top-center region, the hint in the
 * bottom-center region, and the scene layer under the ambient
 * `SceneOverlayRoot`. Asserted through the HUD's real region nodes — a bar
 * that rendered anywhere else (its own `absolute` card, say) would leave
 * the region empty and fail here.
 *
 * `ToolOverlays` no longer mounts its own `SceneOverlayRoot` (#5512):
 * `ViewportContainer` mounts ONE root for the whole viewport (every sibling
 * overlay migrated onto the kernel by #5511/#5512), so this test supplies
 * one itself, the way `ViewportContainer` does in production, and asserts
 * there is exactly one — not the zero a missing ancestor would leave, and
 * not the two a reverted consolidation would produce.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { en } from '@/i18n/en';
import { ViewportHud } from '../viewport-ui/hud/ViewportHud.js';
import { SceneOverlayRoot } from '../viewport-ui/scene';
import { ToolOverlays } from './ToolOverlays.js';

const region = (name: string) => document.querySelector(`[data-hud-region="${name}"]`) as HTMLElement;

beforeEach(() => {
  useViewerStore.setState({
    activeTool: 'select',
    repositionOpen: false,
    splitMode: 'idle',
    splitHoverPoint: null,
    cameraCallbacks: { projectToScreen: () => null, getViewpoint: () => null },
  } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
});

afterEach(() => {
  cleanup();
  useViewerStore.setState({ activeTool: 'select' });
});

describe('ToolOverlays on the TOOL_HUD table (#5503)', () => {
  it('renders under exactly one ambient scene overlay root and leaves the HUD regions empty for the Select tool', () => {
    render(<ViewportHud />);
    const ui = render(<SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot>);
    assert.equal(ui.querySelectorAll('[data-scene-overlay-root]').length, 1);
    assert.equal(region('top-center').querySelectorAll('[data-hud-item]').length, 0);
    assert.equal(region('bottom-center').querySelectorAll('[data-hud-item]').length, 0);
    // Mutation check: reverting `ToolOverlays` to mount its own inner
    // `SceneOverlayRoot` (pre-#5512) would leave TWO
    // `[data-scene-overlay-root]` nodes here, not one.
  });

  it('places the Split bar top-center and its hint bottom-center, and removes both when the tool changes', () => {
    render(<ViewportHud />);
    render(<SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot>);
    act(() => useViewerStore.setState({ activeTool: 'split' }));

    const bar = region('top-center').querySelector('[data-hud-item]');
    assert.ok(bar, 'the Split bar is a top-center HUD item');
    assert.match(bar.textContent ?? '', new RegExp(en['splitTool.barLabel']));
    const hint = region('bottom-center').querySelector('[data-hud-item] [role="status"]');
    assert.ok(hint, 'the registry hint is a bottom-center HUD item');
    assert.equal(hint.textContent, en['splitTool.hint']);

    act(() => useViewerStore.setState({ activeTool: 'select' }));
    assert.equal(region('top-center').querySelectorAll('[data-hud-item]').length, 0);
    assert.equal(region('bottom-center').querySelectorAll('[data-hud-item]').length, 0);
  });

  it('places the Space Sketch bar top-center and its plan card as the next top-center item', () => {
    render(<ViewportHud />);
    render(<SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot>);
    act(() => useViewerStore.setState({ activeTool: 'spaceSketch' }));

    const items = Array.from(region('top-center').querySelectorAll(':scope > [data-hud-item]'));
    assert.equal(items.length, 2, 'bar + plan card, in real DOM order');
    assert.ok(items[0].querySelector('[data-tool-bar="spaceSketch"]'), 'first item is the bar');
    assert.ok(items[1].querySelector('[data-tool-card="spaceSketch"]'), 'second item is the plan card');
    // Nothing in the tool positions itself: no absolute-positioned card
    // outside the HUD regions.
    assert.equal(document.querySelectorAll('[data-tool-card="spaceSketch"]').length, 1);
  });

  it('parks a minimized Space Sketch as a top-left chip and empties top-center', () => {
    render(<ViewportHud />);
    render(<SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot>);
    act(() => useViewerStore.setState({ activeTool: 'spaceSketch' }));
    act(() => useViewerStore.getState().setSpaceSketchMinimized(true));

    assert.equal(region('top-center').querySelectorAll('[data-tool-bar], [data-tool-card]').length, 0);
    const chip = region('top-left').querySelector('[data-hud-item]');
    assert.ok(chip, 'the parked chip is a top-left HUD item');
    assert.match(chip.textContent ?? '', new RegExp(en['spaceSketch.parkedChip.label']));
  });
});
