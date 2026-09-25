/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.viewer.getSection()` / `setSection()` agree with the viewport (#4910).
 *
 * The renderer draws a cut only while the Section tool is active. After the
 * user cut the model and switched to Select, `getSection()` still reported
 * the cut, and `setSection({ enabled: true })` stored a cut nobody could see.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store/index.js';
import { createViewerAdapter } from './viewer-adapter.js';

const viewer = createViewerAdapter(useViewerStore);

beforeEach(() => {
  const s = useViewerStore.getState();
  s.setActiveTool('select');
  s.setSectionPlaneEnabled(false);
  useViewerStore.setState({ sectionPlane: { ...useViewerStore.getState().sectionPlane, custom: undefined } });
});

describe('SDK viewer section (#4910)', () => {
  it('getSection() reports no section after the user leaves the Section tool', () => {
    const s = useViewerStore.getState();
    s.setActiveTool('section');
    s.setSectionPlaneAxis('front');
    s.setSectionPlanePosition(35);
    assert.deepEqual(viewer.getSection(), { axis: 'z', position: 35, enabled: true, flipped: false });

    useViewerStore.getState().setActiveTool('select');
    assert.equal(viewer.getSection(), null, 'BUG: getSection() reports a cut that is not on screen');

    useViewerStore.getState().setActiveTool('section');
    assert.deepEqual(viewer.getSection(), { axis: 'z', position: 35, enabled: true, flipped: false }, 'reopening restores it');
  });

  it('setSection({ enabled: true }) puts the cut on screen, and getSection() reads it back', () => {
    viewer.setSection({ axis: 'x', position: 70, enabled: true, flipped: true });
    const s = useViewerStore.getState();
    assert.equal(s.activeTool, 'section', 'the cut is drawn only by the Section tool');
    assert.deepEqual(viewer.getSection(), { axis: 'x', position: 70, enabled: true, flipped: true });
  });

  it('setSection(null) clears the cut, including the one remembered for the next open', () => {
    viewer.setSection({ axis: 'y', position: 20, enabled: true, flipped: false });
    useViewerStore.getState().setActiveTool('select');
    viewer.setSection(null);
    useViewerStore.getState().setActiveTool('section');
    assert.equal(viewer.getSection(), null);
    assert.equal(useViewerStore.getState().sectionPlane.enabled, false);
  });
});

/**
 * #5644: a face-picked plane's `flipped` is relative to its own normal, so the
 * SDK must map it to the cardinal frame it reports. A pick on the -X face of a
 * box keeps the solid (x > face), which in the +X cardinal frame is flipped.
 */
describe('SDK getSection() after a face pick (#5644)', () => {
  const bounds = { min: [0, 0, 0] as [number, number, number], max: [4, 4, 4] as [number, number, number] };
  for (const sign of [1, -1]) {
    it(`${sign > 0 ? '+' : '-'}X face: reports the kept side in the cardinal frame, and Flip inverts it`, () => {
      const s = useViewerStore.getState();
      s.setActiveTool('section');
      s.setSectionPickMode(true);
      s.setSectionPlaneFromFace([sign, 0, 0], [sign > 0 ? 4 : 0, 2, 2], bounds);
      const picked = viewer.getSection();
      assert.ok(picked, 'the picked cut is on screen');
      assert.equal(picked.axis, 'x');
      assert.equal(picked.flipped, sign < 0, 'the default keeps the solid behind the picked face');

      useViewerStore.getState().flipSectionPlane();
      assert.equal(viewer.getSection()?.flipped, sign > 0, 'Flip keeps the other side');
    });
  }
});
