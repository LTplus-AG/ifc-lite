/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useHudBarTier` (#5975): picks the widest form of a top-center bar that
 * fits the lane as one row. The live widths need real layout (happy-dom
 * reports every box at the same stub width), so the bar-in-the-browser half
 * is the viewport-hud e2e. Here: the tier choice itself, as a pure function
 * of measured widths, and the hook's own wiring. The wiring once looped
 * forever ("Maximum update depth exceeded") with per-render ref callbacks,
 * which mounting the hook at all reproduces.
 */

import '@/test/setup-dom.js';
import { installLayout } from '@/test/dom-layout.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render.js';
import { ViewportHud } from './ViewportHud.js';
import { pickHudBarTier, useHudBarTier } from './useHudBarTier.js';

installLayout();

afterEach(cleanup);

describe('pickHudBarTier (#5975)', () => {
  it('keeps the full bar while it fits the lane', () => {
    assert.equal(pickHudBarTier([583, 487], 700, 2), 0);
  });

  it('drops to the compact form when only it fits (1600px, both panels open)', () => {
    assert.equal(pickHudBarTier([583, 470], 479, 2), 1);
  });

  it('falls through to the smallest, unmeasured form when no measured form fits (1280px)', () => {
    assert.equal(pickHudBarTier([583, 487], 284, 2), 2);
  });

  it('stays on the full bar until both widths are known', () => {
    assert.equal(pickHudBarTier([583, 487], null, 2), 0);
    assert.equal(pickHudBarTier([null, 487], 284, 2), 0);
  });
});

function Harness() {
  const { measureRef, tier } = useHudBarTier(2);
  return (
    <>
      <div ref={measureRef(0)}>full</div>
      <div ref={measureRef(1)}>compact</div>
      <span data-testid="tier">{tier}</span>
    </>
  );
}

describe('useHudBarTier wiring (#5975)', () => {
  it('mounts and measures without an infinite update loop', () => {
    // A regression throws "Maximum update depth exceeded" out of `render()`.
    const ui = render(<><ViewportHud /><Harness /></>);
    assert.ok(ui.querySelector('[data-testid="tier"]'), 'the harness mounted');
  });
});
