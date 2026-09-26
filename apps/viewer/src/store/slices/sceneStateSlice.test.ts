/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `sceneState.section.visible` / `sceneState.measurements.visible` (#5893,
 * part of #5611 deliverable 3): the section cut and finished measurements
 * are lasting scene state the user toggles, not something owned by which
 * tool happens to be open.
 *
 * On main (pre-#5893): switching from Section to Measure parked the cut
 * (`sectionPlane.enabled` forced `false`, `store/section-active.ts`), so the
 * renderer stopped receiving the plane; finished measurements were drawn
 * only by `MeasureOverlay`, mounted only while `activeTool === 'measure'`
 * (`ToolOverlays.tsx`), so they vanished on switching to Select. These
 * tests drive the real store through its actions and fail against that
 * behaviour.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '../index.js';
import { activeSectionPlane } from '../section-active.js';
import { sectionRenderClip } from '@/lib/section/section-render-clip';
import { hasPendingMeasurementState } from '@/utils/viewportUtils';

function state() {
  return useViewerStore.getState();
}

beforeEach(() => {
  state().setActiveTool('select');
  state().setSectionPlaneEnabled(false);
  state().setSectionVisible(true);
  state().setMeasurementsVisible(true);
  state().clearMeasurements();
});

describe('sceneState.section.visible (#5893)', () => {
  it('with the section visible, switching to Measure keeps the renderer receiving the plane', () => {
    state().setActiveTool('section');
    state().setSectionPlaneAxis('front');
    state().setSectionPlanePosition(30);
    assert.ok(activeSectionPlane(state()), 'on screen inside the Section tool');
    const insideClip = sectionRenderClip(state().sceneState.section.visible, state().sectionPlane, null);
    assert.ok(insideClip.sectionPlane, 'the renderer receives the plane inside the tool');

    state().setActiveTool('measure');
    assert.ok(activeSectionPlane(state()), 'BUG on main: the cut vanished the moment Measure opened');
    const afterSwitchClip = sectionRenderClip(state().sceneState.section.visible, state().sectionPlane, null);
    assert.ok(afterSwitchClip.sectionPlane, 'the renderer keeps receiving the plane after switching to Measure');
    assert.equal(afterSwitchClip.sectionPlane?.enabled, true);
  });

  it('toggling the chip (setSectionVisible) hides and shows the cut, independent of the active tool', () => {
    state().setActiveTool('section');
    state().setSectionPlaneAxis('down');
    state().setActiveTool('measure');
    assert.ok(activeSectionPlane(state()));

    state().setSectionVisible(false);
    assert.equal(activeSectionPlane(state()), null, 'hidden by the toggle');
    assert.equal(sectionRenderClip(state().sceneState.section.visible, state().sectionPlane, null).sectionPlane, undefined);

    state().setSectionVisible(true);
    assert.ok(activeSectionPlane(state()), 'shown again');
    assert.ok(sectionRenderClip(state().sceneState.section.visible, state().sectionPlane, null).sectionPlane);
  });

  it('toggleSectionVisible flips the current value', () => {
    state().setActiveTool('section');
    state().setSectionPlaneAxis('down');
    assert.equal(state().sceneState.section.visible, true);
    state().toggleSectionVisible();
    assert.equal(state().sceneState.section.visible, false);
    state().toggleSectionVisible();
    assert.equal(state().sceneState.section.visible, true);
  });
});

describe('sceneState.measurements.visible (#5893)', () => {
  it('a finished measurement stays drawable after switching from Measure to Select', () => {
    state().setActiveTool('measure');
    useViewerStore.setState({
      measurements: [{
        id: 'm1',
        start: { x: 0, y: 0, z: 0, screenX: 10, screenY: 10 },
        end: { x: 1, y: 0, z: 0, screenX: 20, screenY: 10 },
        distance: 1,
      }],
    });
    assert.ok(hasPendingMeasurementState(state()), 'a finished measurement needs reprojection while Measure is open');

    state().setActiveTool('select');
    assert.equal(state().measurements.length, 1, 'BUG on main: the finished measurement is discarded — MeasureOverlay unmounts');
    assert.equal(state().sceneState.measurements.visible, true, 'still shown by default');
    assert.ok(hasPendingMeasurementState(state()), 'still needs reprojection so the always-mounted scene layer tracks the camera');
  });

  it('toggling the chip hides and shows finished measurements, independent of the active tool', () => {
    useViewerStore.setState({
      measurements: [{
        id: 'm1',
        start: { x: 0, y: 0, z: 0, screenX: 10, screenY: 10 },
        end: { x: 1, y: 0, z: 0, screenX: 20, screenY: 10 },
        distance: 1,
      }],
    });
    state().setActiveTool('select');
    assert.equal(state().sceneState.measurements.visible, true);

    state().setMeasurementsVisible(false);
    assert.equal(state().sceneState.measurements.visible, false);
    assert.equal(state().measurements.length, 1, 'hiding does not discard the data');

    state().setMeasurementsVisible(true);
    assert.equal(state().sceneState.measurements.visible, true);
  });

  it('toggleMeasurementsVisible flips the current value', () => {
    assert.equal(state().sceneState.measurements.visible, true);
    state().toggleMeasurementsVisible();
    assert.equal(state().sceneState.measurements.visible, false);
    state().toggleMeasurementsVisible();
    assert.equal(state().sceneState.measurements.visible, true);
  });
});
