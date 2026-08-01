/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure positioning math for `SearchableSelect`'s portaled popup (#1924).
 *
 * `computeSearchableSelectAnchor` decides whether the popup opens down
 * (default) or flips up when there isn't enough room below the trigger —
 * the "flip near the bottom of a docked/floating panel" half of the fix
 * described in the issue. No DOM needed; this is plain arithmetic on a
 * trigger rect plus a viewport height.
 */

// `LensPanel.tsx` transitively imports the Zustand store, whose slices touch
// browser globals (localStorage, etc.) at module init — register happy-dom
// FIRST, same requirement as the rendering test alongside this one.
import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeSearchableSelectAnchor } from './LensPanel.js';

describe('computeSearchableSelectAnchor (#1924)', () => {
  it('opens down when there is plenty of room below the trigger', () => {
    const anchor = computeSearchableSelectAnchor(
      { left: 20, width: 200, top: 100, bottom: 130 },
      /* viewportHeight */ 800,
    );
    assert.equal(anchor.openUp, false);
    assert.equal(anchor.top, 130, 'top anchors to the trigger bottom');
    assert.equal(anchor.left, 20);
    assert.equal(anchor.width, 200);
  });

  it('flips up when the trigger sits near the bottom of the viewport', () => {
    // Viewport is 800px tall; trigger bottom is at 780px, leaving only 20px
    // below it — far less than the popup's max-height (200px) — while 750px
    // of room exists above.
    const anchor = computeSearchableSelectAnchor(
      { left: 20, width: 200, top: 750, bottom: 780 },
      800,
    );
    assert.equal(anchor.openUp, true);
    assert.equal(anchor.bottom, 50, 'bottom anchors to (viewportHeight - trigger.top)');
  });

  it('does NOT flip up when there is even less room above than below (nowhere better to go)', () => {
    // Trigger near the very top: 10px above, 780px below available minus the
    // trigger's own height — either way, above is worse than below.
    const anchor = computeSearchableSelectAnchor(
      { left: 20, width: 200, top: 10, bottom: 40 },
      800,
    );
    assert.equal(anchor.openUp, false);
  });

  it('respects a custom popup max-height threshold', () => {
    // 60px of room below is enough for a 50px-tall popup, so it should NOT flip.
    const roomy = computeSearchableSelectAnchor(
      { left: 0, width: 100, top: 700, bottom: 740 },
      800,
      50,
    );
    assert.equal(roomy.openUp, false);

    // The same geometry with the default 200px popup height DOES flip.
    const cramped = computeSearchableSelectAnchor(
      { left: 0, width: 100, top: 700, bottom: 740 },
      800,
    );
    assert.equal(cramped.openUp, true);
  });
});
