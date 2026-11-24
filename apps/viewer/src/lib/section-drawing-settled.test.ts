/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Renderer } from '@ifc-lite/renderer';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import { isSectionDrawingSettled } from './section-drawing-settled';
import { markActiveDrawingGenerationCompleted, markActiveDrawingGenerationStarted } from './drawing/active-canvas-snapshot';
import { clearViewportDebugHooks, installViewportDebugHooks } from './viewport-debug-hooks';
import { useViewerStore } from '@/store';

type State = Parameters<typeof isSectionDrawingSettled>[0];
const plane = { axis: 'down', position: 50, enabled: true, flipped: false } as State['sectionPlane'];
const drawing = {} as Drawing2D;
const state = (over: Partial<State> = {}): State => ({
  drawing2DPanelVisible: false, activeTool: 'section',
  drawing2DDisplayOptions: { show3DOverlay: true } as State['drawing2DDisplayOptions'],
  drawing2DStatus: 'ready', drawing2D: drawing, drawing2DPlane: { axis: 'down', position: 50, flipped: false }, sectionPlane: plane, ...over,
});

describe('section drawing settled (#11428)', () => {
  it('is settled when no drawing is wanted, whatever is pending', () => {
    assert.equal(isSectionDrawingSettled(state({ activeTool: 'select', drawing2DStatus: 'generating' }), true), true);
    assert.equal(isSectionDrawingSettled(state({ drawing2DDisplayOptions: { show3DOverlay: false } as State['drawing2DDisplayOptions'], drawing2DStatus: 'generating' }), true), true);
  });

  it('waits for a running generation, from the section cap or the 2D panel', () => {
    assert.equal(isSectionDrawingSettled(state({ drawing2DStatus: 'generating' }), false), false);
    assert.equal(isSectionDrawingSettled(state(), true), false, 'started, status not yet raised (a regenerate keeps "ready")');
    assert.equal(isSectionDrawingSettled(state({ activeTool: 'select', drawing2DPanelVisible: true }), true), false);
  });

  it('waits while the drawing on screen was cut at a plane the live one has left', () => {
    assert.equal(isSectionDrawingSettled(state({ sectionPlane: { ...plane, position: 51 } }), false), false);
    assert.equal(isSectionDrawingSettled(state({ sectionPlane: { ...plane, flipped: true } }), false), false);
    assert.equal(isSectionDrawingSettled(state(), false), true, 'the live plane\'s drawing');
    assert.equal(isSectionDrawingSettled(state({ drawing2DPlane: null }), false), true, 'a drawing published without its plane is the live one');
  });

  it('is settled at idle (nothing to draw) and at error: nothing more will arrive', () => {
    assert.equal(isSectionDrawingSettled(state({ drawing2DStatus: 'idle', drawing2D: null, drawing2DPlane: null }), false), true);
    assert.equal(isSectionDrawingSettled(state({ drawing2DStatus: 'error' }), false), true);
  });
});

describe('__ifc_lite_scene_settled__ covers the section drawing (#11428)', () => {
  afterEach(clearViewportDebugHooks);

  it('stays unsettled while the cap\'s drawing generates, and settles when it lands', () => {
    const renderer = { getScene: () => ({}) } as unknown as Renderer;
    installViewportDebugHooks(renderer, () => ({ hiddenIds: new Set(), isolatedIds: null }), () => 0);
    const settled = (globalThis as Record<string, unknown>).__ifc_lite_scene_settled__ as () => boolean;
    const store = useViewerStore.getState();
    const previous = { activeTool: store.activeTool, sectionPlane: store.sectionPlane };
    try {
      useViewerStore.setState({ activeTool: 'section', sectionPlane: { ...store.sectionPlane, enabled: true } });
      markActiveDrawingGenerationStarted();
      assert.equal(settled(), false, 'a generation is running');
      useViewerStore.setState({ drawing2D: drawing, drawing2DPlane: null, drawing2DStatus: 'ready' });
      markActiveDrawingGenerationCompleted(drawing);
      assert.equal(settled(), true, 'the drawing landed');
    } finally {
      useViewerStore.setState({ ...previous, drawing2D: null, drawing2DPlane: null, drawing2DStatus: 'idle' });
    }
  });
});
