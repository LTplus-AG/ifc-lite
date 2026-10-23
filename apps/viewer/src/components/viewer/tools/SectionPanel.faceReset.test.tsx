/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5644 follow-up, through the mounted Section bar (#5499, #7545): after a face
 * pick, adding a cardinal plane (even the picked plane's own axis) is a NEW
 * plane and must leave the picked plane's cut exactly as it was. A -X pick
 * keeps the solid at x > face, which in the +X cardinal frame is `flipped:
 * true`; the pick itself stores `flipped: false` relative to its own normal,
 * and nothing the bar does afterwards may carry that raw value onto another
 * plane or rewrite it. (Choosing an axis for the ACTIVE plane no longer has a
 * bar entry point; `resetSectionToAxis` itself is covered by
 * `sectionFacePick.test.ts`.)
 */

import '@/test/setup-dom.js';
import '@/test/section-tool-ready.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, click, render } from '@/test/render.js';
import { addPlaneFromMenu } from '@/test/section-bar.js';
import { useViewerStore } from '@/store';
import { cardinalSectionFlipped } from '@/store/section-active.js';
import { getDefaultSectionPlane } from '@/store/slices/sectionSlice.js';
import { ViewportHud } from '../../viewport-ui/hud/ViewportHud.js';
import { ToolOverlays } from '../ToolOverlays.js';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';

const s = () => useViewerStore.getState();
const bounds = { min: [0, 0, 0] as [number, number, number], max: [4, 4, 4] as [number, number, number] };

function chip(name: string): HTMLButtonElement {
  const bar = document.querySelector('[data-tool-bar="section"]');
  assert.ok(bar, 'the Section bar is mounted');
  const result = [...bar.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((candidate) => candidate.textContent?.trim() === name);
  assert.ok(result, `plane chip ${name}`);
  return result;
}

/** Mount the Section tool and pick the -X face of a [0,4]^3 box as the first plane. */
function pickMinusX(): void {
  render(<><ViewportHud /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
  // The empty state's "Face…" button arms a pick that ADDS a plane.
  const face = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="section-empty-add"] button')].find((b) => b.textContent?.trim() === 'Face…');
  assert.ok(face, 'the empty state offers Face…');
  click(face);
  assert.equal(s().sectionPickMode, true);
  act(() => { s().setSectionPlaneFromFace([-1, 0, 0], [0, 2, 2], bounds); });
  assert.ok(s().sectionPlane.custom, 'the pick committed a custom plane');
  assert.equal(s().sectionPlane.flipped, false, 'custom-frame default side');
  assert.equal(s().sectionPlane.name, 'A');
  assert.equal(chip('A').getAttribute('aria-selected'), 'true');
}

beforeEach(() => {
  window.localStorage.clear();
  useViewerStore.setState({
    activeTool: 'section',
    sectionPlane: getDefaultSectionPlane(),
    inactiveSectionPlanes: [],
    sectionUndo: null,
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

describe('Section bar cardinal plane added after a -X face pick (#5644, #7545)', () => {
  it("Side (the pick's own axis) is a new plane; the picked plane keeps the solid behind its face", () => {
    pickMinusX();
    const picked = s().sectionPlane;
    assert.equal(cardinalSectionFlipped(picked), true, 'x > face stays: the flipped side of the +X cut');
    addPlaneFromMenu('Side (X)');
    assert.equal(s().sectionPlane.name, 'B');
    assert.equal(s().sectionPlane.custom, undefined);
    assert.equal(s().sectionPlane.axis, 'side');
    assert.equal(s().sectionPlane.flipped, false, 'a new cardinal cut starts on its default side');
    assert.equal(chip('B').getAttribute('aria-selected'), 'true');
    assert.deepEqual(s().inactiveSectionPlanes, [picked], 'the picked plane is untouched');
    click(chip('A'));
    assert.deepEqual(s().sectionPlane, picked, 'activating it again gives back the same cut');
    assert.equal(cardinalSectionFlipped(s().sectionPlane), true);
  });

  it('another axis is a new cut too and leaves the picked plane alone', () => {
    pickMinusX();
    const picked = s().sectionPlane;
    addPlaneFromMenu('Down (Z)');
    assert.equal(s().sectionPlane.custom, undefined);
    assert.equal(s().sectionPlane.axis, 'down');
    assert.equal(s().sectionPlane.flipped, false);
    assert.deepEqual(s().inactiveSectionPlanes, [picked]);
  });
});
