/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5644 follow-up, through the mounted Section bar (#5499): after a face
 * pick, the axis segment for the picked plane's own axis must keep the side
 * that is on screen. A -X pick keeps the solid at x > face, which in the +X
 * cardinal frame is `flipped: true`; carrying the pick's raw custom-frame
 * `flipped: false` over inverted the cut.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { ToolOverlays } from '../ToolOverlays.js';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';

const s = () => useViewerStore.getState();
const bounds = { min: [0, 0, 0] as [number, number, number], max: [4, 4, 4] as [number, number, number] };

function segment(text: string): HTMLButtonElement {
  const bar = document.querySelector('[data-tool-bar="section"]');
  assert.ok(bar, 'the Section bar is mounted');
  const result = [...bar.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((candidate) => candidate.textContent?.trim() === text);
  assert.ok(result, `segment ${text}`);
  return result;
}

/** Mount the Section tool and pick the -X face of a [0,4]^3 box. */
function pickMinusX(): void {
  render(<><ViewportHud /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
  act(() => {
    s().setSectionPickMode(true);
    s().setSectionPlaneFromFace([-1, 0, 0], [0, 2, 2], bounds);
  });
  assert.ok(s().sectionPlane.custom, 'the pick committed a custom plane');
  assert.equal(s().sectionPlane.flipped, false, 'custom-frame default side');
  assert.equal(segment('Face').getAttribute('aria-checked'), 'true');
}

beforeEach(() => {
  window.localStorage.clear();
  useViewerStore.setState({
    activeTool: 'section',
    sectionPlane: getDefaultSectionPlane(),
    sectionPickMode: false,
    sectionPickPreview: null,
    drawing2DPanelVisible: false,
    drawing2D: null,
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('Section bar cardinal choice after a -X face pick (#5644)', () => {
  it("the Side segment (the pick's own axis) keeps the solid behind the face", () => {
    pickMinusX();
    click(segment('Side'));
    assert.equal(s().sectionPlane.custom, undefined);
    assert.equal(s().sectionPlane.axis, 'side');
    assert.equal(s().sectionPlane.flipped, true, 'x > face stays: the flipped side of the +X cut');
    assert.equal(segment('Side').getAttribute('aria-checked'), 'true');
  });

  it('another axis segment is a new cut and leaves the flip alone', () => {
    pickMinusX();
    click(segment('Down'));
    assert.equal(s().sectionPlane.custom, undefined);
    assert.equal(s().sectionPlane.axis, 'down');
    assert.equal(s().sectionPlane.flipped, false);
  });
});
