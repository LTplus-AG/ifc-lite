/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6374 "Section plane - Always visible": after opening a new file the 3D view
 * showed a section plane that nothing could hide.
 *
 * What the renderer is handed is `sectionRenderClip(...)`, called from
 * `useAnimationLoop` with exactly these store reads. The renderer draws a
 * translucent preview quad for ANY plane it is handed, cutting or not
 * (`render-section-draw.ts`). Since #5893 the only gate was
 * `sceneState.section.visible`, which every file load resets to `true`, so a
 * NOT-cutting plane (the state every file load leaves behind) was handed over
 * on every frame. The HUD chip that owns the hide toggle only renders while a
 * cut is enabled, so there was nothing to click.
 *
 * These drive the real store through the user's actions and the real
 * file-load reset (`resetViewerState`, called by `useIfcLoader.loadFile` for a
 * primary load), then ask what the renderer receives.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { clearSectionCut } from '@/store/section-active';
import { sectionRenderClip } from './section-render-clip.js';

const state = () => useViewerStore.getState();
/** The renderer's section inputs for the current store, as `useAnimationLoop` builds them. */
const rendered = () => sectionRenderClip(state().sceneState.section.visible, state().sectionPlane, { min: 0, max: 10 }, state().activeTool);

beforeEach(() => {
  state().resetViewerState();
  state().setActiveTool('select');
});

describe('the uncut section preview only draws while the Section tool is open (#6374)', () => {
  it('a freshly loaded file hands the renderer no section plane', () => {
    // File 1: the user cuts, hides the cut from the chip, closes the tool.
    state().setActiveTool('section');
    state().setSectionPlaneAxis('front');
    state().setSectionPlanePosition(30);
    state().setActiveTool('select');
    state().setSectionVisible(false);

    // File 2 is opened.
    state().resetViewerState();
    state().setActiveTool('select');

    assert.equal(state().sectionPlane.enabled, false, 'the load reset turns the cut off');
    assert.deepEqual(rendered(), {}, 'BUG #6374: the renderer drew a plane on a freshly loaded file');
  });

  it('"Forget this cut" (X) on the section chip leaves nothing on screen', () => {
    state().setActiveTool('section');
    state().setSectionPlaneAxis('down');
    state().setActiveTool('select');
    assert.equal(rendered().sectionPlane?.enabled, true, 'the lasting cut is on screen outside the tool (#5893)');

    clearSectionCut(state);

    assert.deepEqual(rendered(), {}, 'BUG #6374: clearing the cut left its preview plane drawn');
  });

  it('opening the Section tool still shows the preview, and closing it takes the preview away', () => {
    state().setActiveTool('section');
    assert.equal(state().sectionPlane.enabled, false);
    assert.equal(rendered().sectionPlane?.enabled, false, 'the tool shows where a cut would go before it cuts');

    state().setActiveTool('select');
    assert.deepEqual(rendered(), {});
  });

  it('an enabled cut is still lasting scene state outside the tool, and the chip still hides it (#5893)', () => {
    state().setActiveTool('section');
    state().setSectionPlaneAxis('side');
    state().setActiveTool('measure');
    assert.equal(rendered().sectionPlane?.enabled, true);

    state().setSectionVisible(false);
    assert.deepEqual(rendered(), {});
  });
});
