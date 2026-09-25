/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5644 follow-up, through the mounted panel: after a face pick, both "Reset
 * to nearest cardinal axis" and the axis button for the picked plane's own axis
 * must keep the side that is on screen. A -X pick keeps the solid at x > face,
 * which in the +X cardinal frame is `flipped: true`; carrying the pick's raw
 * custom-frame `flipped: false` over inverted the cut.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { ToolOverlays } from '../ToolOverlays.js';

const s = () => useViewerStore.getState();
const bounds = { min: [0, 0, 0] as [number, number, number], max: [4, 4, 4] as [number, number, number] };

function button(ui: HTMLElement, text: string): HTMLButtonElement {
  const result = [...ui.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.trim() === text || candidate.title === text);
  assert.ok(result, `button ${text}`);
  return result;
}

/** Mount the Section tool, pick the -X face of a [0,4]^3 box, expand the panel. */
function pickMinusX(): HTMLElement {
  const ui = render(<ToolOverlays />);
  s().setSectionPickMode(true);
  s().setSectionPlaneFromFace([-1, 0, 0], [0, 2, 2], bounds);
  const heading = [...ui.querySelectorAll('button')].find((candidate) => candidate.textContent?.includes('Section'));
  assert.ok(heading);
  click(heading);
  assert.ok(s().sectionPlane.custom, 'the pick committed a custom plane');
  assert.equal(s().sectionPlane.flipped, false, 'custom-frame default side');
  return ui;
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

describe('Section panel cardinal choice after a -X face pick (#5644)', () => {
  it('"Reset to nearest cardinal axis" keeps the solid behind the face', () => {
    const ui = pickMinusX();
    click(button(ui, 'Reset to nearest cardinal axis'));
    assert.equal(s().sectionPlane.custom, undefined);
    assert.equal(s().sectionPlane.axis, 'side');
    assert.equal(s().sectionPlane.flipped, true, 'x > face stays: the flipped side of the +X cut');
  });

  it('the Side button (the pick\'s own axis) keeps the same side', () => {
    const ui = pickMinusX();
    click(button(ui, 'Side'));
    assert.equal(s().sectionPlane.custom, undefined);
    assert.equal(s().sectionPlane.flipped, true);
  });

  it('another axis button is a new cut and leaves the flip alone', () => {
    const ui = pickMinusX();
    click(button(ui, 'Down'));
    assert.equal(s().sectionPlane.custom, undefined);
    assert.equal(s().sectionPlane.axis, 'down');
    assert.equal(s().sectionPlane.flipped, false);
  });
});
