/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The persisted section mode is the second home of model-relative state, and
 * a reset that misses it is not a reset (#2939).
 *
 * `resetViewerState()` clears the in-memory `axis`/`position`/`enabled`/
 * `flipped` because, in its own words, they are "model-relative and
 * meaningless when switching files". `ifc-lite:section-last-mode` persists
 * exactly those four fields and was never cleared, so `loadLastSectionMode()`
 * read them back on the next panel mount and a cardinal cut made on one model
 * reappeared pre-chosen on the next.
 *
 * These pin the clear/save/load contract at the slice level. The store-level
 * wiring (that `resetViewerState` actually calls `clearLastSectionMode`) is
 * covered separately -- see the PR, which records why a store-level test needs
 * a DOM stub this suite does not yet have a pattern for.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A real `window` and a real `localStorage` via the repo's happy-dom harness,
 * rather than a hand-rolled stub. Defining `window` at all makes every module
 * in this import graph take its browser branch, so a partial stub sends you
 * chasing `matchMedia`, then `location.search`, then whatever the next module
 * reaches for. The harness already answers all of it.
 */
import '../../test/setup-dom.js';

const { __saveLastSectionModeForTest, clearLastSectionMode, loadLastSectionMode } =
  await import('./sectionSlice.js');

describe('persisted section mode (#2939)', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a cardinal mode, so the clear below is not vacuous', () => {
    __saveLastSectionModeForTest({ kind: 'cardinal', axis: 'down', position: 42, flipped: true });
    const loaded = loadLastSectionMode();
    assert.equal(loaded.kind, 'cardinal');
    assert.deepEqual(loaded, { kind: 'cardinal', axis: 'down', position: 42, flipped: true });
  });

  it('clearLastSectionMode re-arms face-pick', () => {
    __saveLastSectionModeForTest({ kind: 'cardinal', axis: 'side', position: 80, flipped: false });
    assert.equal(loadLastSectionMode().kind, 'cardinal', 'precondition');

    clearLastSectionMode();

    assert.equal(
      loadLastSectionMode().kind,
      'pick',
      'a cleared mode must fall back to pick, which is what re-offers the face picker',
    );
  });

  it('leaves the cap appearance keys alone', () => {
    // The reset deliberately preserves these: they are display style, not
    // geometry, and clobbering them caused "my hatch / colour resets to
    // defaults every time I open a file". A clear that took them too would
    // look identical to a correct one from the test above alone.
    localStorage.setItem('ifc-lite:section-cap-style', '"diagonal"');
    localStorage.setItem('ifc-lite:section-cap-show', 'true');
    localStorage.setItem('ifc-lite:section-outlines-show', 'false');

    clearLastSectionMode();

    assert.equal(localStorage.getItem('ifc-lite:section-cap-style'), '"diagonal"');
    assert.equal(localStorage.getItem('ifc-lite:section-cap-show'), 'true');
    assert.equal(localStorage.getItem('ifc-lite:section-outlines-show'), 'false');
  });
});
