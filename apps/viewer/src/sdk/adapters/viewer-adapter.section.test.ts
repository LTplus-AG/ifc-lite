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
