/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9718: the mobile shell's grid per form factor. The pane's width and its
 * safe-area padding are asserted here, on the pure layout, because happy-dom
 * drops `clamp()` and `env()` from inline styles; the real browser layout is
 * `tests/e2e/mobile-form-factor.e2e.spec.ts`'s.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFormFactor, type SegmentRect } from '@/lib/layout/form-factor';
import { mobileShellLayout } from './mobile-shell-layout.js';

const touch = (width: number, height: number, segments?: SegmentRect[]) =>
  classifyFormFactor({ width, height, coarsePointer: true, segments });

describe('mobileShellLayout (#9718)', () => {
  it('a portrait phone and the cover screen: the viewport over the bar, no pane track', () => {
    for (const ff of [touch(412, 960), touch(360, 400)]) {
      const layout = mobileShellLayout(ff);
      assert.equal(layout.fixed, false);
      assert.equal(layout.shell.gridTemplateAreas, '"view" "bar"');
      assert.deepEqual(layout.pane, {});
    }
  });

  it('a phone on its side: viewport | pane | rail, the pane 40% clamped to 280-380px, clear of the top and bottom insets', () => {
    const layout = mobileShellLayout(touch(960, 412));
    assert.equal(layout.shell.gridTemplateAreas, '"view pane bar"');
    assert.equal(layout.shell.gridTemplateColumns, 'minmax(0, 1fr) auto auto');
    assert.deepEqual(layout.pane, {
      width: 'clamp(280px, 40vw, 380px)',
      paddingTop: 'env(safe-area-inset-top)',
      paddingBottom: 'env(safe-area-inset-bottom)',
    });
  });

  it('a near-tablet: the pane on the trailing edge, 360px plus the right inset it pads, the bar under both', () => {
    const layout = mobileShellLayout(touch(830, 750));
    assert.equal(layout.shell.gridTemplateAreas, '"view pane" "bar bar"');
    assert.deepEqual(layout.pane, {
      width: 'calc(360px + env(safe-area-inset-right))',
      paddingTop: 'env(safe-area-inset-top)',
      paddingRight: 'env(safe-area-inset-right)',
    });
  });

  it('a tabletop fold pins the viewport row to the top segment and leaves the hinge an empty track', () => {
    const layout = mobileShellLayout(touch(412, 960, [{ x: 0, y: 0, width: 412, height: 470 }, { x: 0, y: 490, width: 412, height: 470 }]));
    assert.equal(layout.fixed, true);
    assert.equal(layout.shell.gridTemplateAreas, '"." "view" "." "pane" "bar"');
    assert.equal(layout.shell.gridTemplateRows, '0px 470px 20px minmax(0, 1fr) auto');
  });

  it('a book fold splits the columns at the hinge, whichever order the browser lists the segments in', () => {
    const left = { x: 0, y: 0, width: 405, height: 750 };
    const right = { x: 425, y: 0, width: 405, height: 750 };
    for (const segments of [[left, right], [right, left]]) {
      const layout = mobileShellLayout(touch(830, 750, segments));
      assert.equal(layout.shell.gridTemplateAreas, '". view . pane" ". view . bar"');
      assert.equal(layout.shell.gridTemplateColumns, '0px 405px 20px minmax(0, 1fr)');
    }
  });
});
