/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeFloatingPanelStyle, type SnapBounds } from './floating-panel-geometry.js';
import type { FloatingPanelState, SnapZone } from '@/store';

function panel(snap: SnapZone, over: Partial<FloatingPanelState> = {}): FloatingPanelState {
  return { id: 'properties', snap, x: 120, y: 200, w: 360, h: 460, ...over };
}

// A viewport region that starts BELOW a 48px toolbar and stops ABOVE a 24px
// status bar, inset on the right by a 300px sidebar — the shape that makes a
// docked panel's title bar reachable instead of buried (#1245).
const BOUNDS: SnapBounds = { top: 48, left: 0, right: 300, bottom: 24, width: 900, height: 800 };

describe('computeFloatingPanelStyle', () => {
  it('places a free panel at its stored window coordinates', () => {
    const s = computeFloatingPanelStyle(panel('free'), BOUNDS);
    assert.deepEqual(s, { left: 120, top: 200, width: 360, height: 460 });
  });

  it('right-snaps inside the region, NOT under the toolbar (regression #1245)', () => {
    const s = computeFloatingPanelStyle(panel('right'), BOUNDS);
    // top must follow the region (below the toolbar), never 0 — that buried
    // the title bar (and its close control) under the z-50 toolbar.
    assert.equal(s.top, 48);
    assert.equal(s.right, 300);
    assert.equal(s.bottom, 24);
    assert.equal(s.left, undefined);
    assert.equal(s.width, 360);
  });

  it('left-snaps to the region top/left edge', () => {
    const s = computeFloatingPanelStyle(panel('left'), BOUNDS);
    assert.equal(s.top, 48);
    assert.equal(s.left, 0);
    assert.equal(s.bottom, 24);
    assert.equal(s.right, undefined);
  });

  it('bottom-snaps to the region bottom and spans its width (no top)', () => {
    const s = computeFloatingPanelStyle(panel('bottom'), BOUNDS);
    assert.equal(s.bottom, 24);
    assert.equal(s.left, 0);
    assert.equal(s.right, 300);
    assert.equal(s.top, undefined);
    assert.equal(s.height, 460);
  });

  it('clamps a snapped panel so it cannot outgrow the region', () => {
    const wide = computeFloatingPanelStyle(panel('right', { w: 5000 }), BOUNDS);
    assert.equal(wide.width, 900); // clamped to bounds.width

    const tall = computeFloatingPanelStyle(panel('bottom', { h: 5000 }), BOUNDS);
    assert.equal(tall.height, 800); // clamped to bounds.height
  });

  it('falls back to window edges when bounds is not yet measured', () => {
    const s = computeFloatingPanelStyle(panel('right', { w: 5000 }), null);
    assert.equal(s.top, 0);
    assert.equal(s.right, 0);
    assert.equal(s.bottom, 0);
    assert.equal(s.width, 5000); // unclamped without a region
  });
});
