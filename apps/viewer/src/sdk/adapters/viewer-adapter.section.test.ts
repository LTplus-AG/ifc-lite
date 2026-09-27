/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.viewer.getSection()` / `setSection()` agree with the viewport (#4910,
 * revised by #5893).
 *
 * #4910: the renderer used to draw a cut only while the Section tool was
 * active. After the user cut the model and switched to Select,
 * `getSection()` still reported the cut, and `setSection({ enabled: true })`
 * stored a cut nobody could see.
 *
 * #5893 makes the cut lasting scene state: leaving the Section tool no
 * longer hides it (`store/section-active.ts`'s `activeSectionPlane()` now
 * gates on `sceneState.section.visible`, not `activeTool`), so
 * `getSection()` keeps reporting the same cut across a tool switch, and
 * `setSection({ enabled: true })` puts it on screen immediately regardless
 * of tool.
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

describe('SDK viewer section (#4910, #5893)', () => {
  it('getSection() keeps reporting the cut after the user leaves the Section tool (#5893)', () => {
    const s = useViewerStore.getState();
    s.setActiveTool('section');
    s.setSectionPlaneAxis('front');
    s.setSectionPlanePosition(35);
    assert.deepEqual(viewer.getSection(), { axis: 'z', position: 35, enabled: true, flipped: false });

    useViewerStore.getState().setActiveTool('select');
    assert.deepEqual(viewer.getSection(), { axis: 'z', position: 35, enabled: true, flipped: false },
      'BUG (pre-#5893): getSection() reported a cut that was not on screen — now it IS on screen, lasting scene state');

    useViewerStore.getState().setActiveTool('section');
    assert.deepEqual(viewer.getSection(), { axis: 'z', position: 35, enabled: true, flipped: false }, 'reopening shows the same cut');
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

describe('SDK setSection() without `flipped` after a face pick (#5644 follow-up)', () => {
  it('falls back to the side on screen, not the raw custom-frame flag', () => {
    const s = useViewerStore.getState();
    s.setActiveTool('section');
    // A -X face at x = 0: the default keeps the solid at x > 0, which is the
    // flipped side in the +X cardinal frame (custom-frame `flipped` is false).
    s.setSectionPlaneFromFace([-1, 0, 0], [0, 1, 1], { min: [0, 0, 0], max: [4, 4, 4] });
    const reported = viewer.getSection();
    assert.equal(reported?.flipped, true);
    // `flipped` is required by the type, but untyped callers (sandbox scripts,
    // JSON over the bridge) omit it and hit the adapter's fallback.
    const untyped: unknown = { axis: 'x', position: reported!.position, enabled: true };
    viewer.setSection(untyped as Parameters<typeof viewer.setSection>[0]);
    const after = useViewerStore.getState().sectionPlane;
    assert.equal(after.custom, undefined);
    assert.equal(after.flipped, true);
  });
});
