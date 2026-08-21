/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model-relative section state has TWO homes, and a reset that clears one is
 * not a reset (#2939).
 *
 * `resetViewerState()` already cleared the in-memory `axis`/`position`/
 * `enabled`/`flipped`, for the reason its own comment gives: they are
 * "model-relative and meaningless when switching files". The persisted
 * `ifc-lite:section-last-mode` key holds exactly those four fields, was never
 * cleared, and `loadLastSectionMode()` reads it back on the next panel mount.
 * So the reset was undone the moment the panel remounted, and a cardinal cut
 * from one model reappeared pre-chosen on the next -- the user never being
 * offered the face picker again on any file.
 *
 * These assert on the PERSISTED value, not on the store fields. Asserting the
 * store would pass without the fix, because the store half was already
 * correct: the whole bug lived in the copy that outlives it.
 */

import '../test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { useViewerStore, loadLastSectionMode } = await import('./index.js');

describe('resetViewerState and the persisted section mode (#2939)', () => {
  beforeEach(() => localStorage.clear());

  it('drops a cardinal mode saved against the previous model', () => {
    // Real actions, not a test-only setter: these are the production write
    // path that creates the stale value, so the fixture cannot drift from
    // what a user actually does.
    const s = useViewerStore.getState();
    s.setSectionPlaneAxis('down');
    s.setSectionPlanePosition(42);
    s.flipSectionPlane();
    assert.equal(
      loadLastSectionMode().kind,
      'cardinal',
      'precondition: the mode must really be persisted, or the assertion below proves nothing',
    );

    useViewerStore.getState().resetViewerState();

    assert.equal(
      loadLastSectionMode().kind,
      'pick',
      'a model switch must re-arm face-pick: a cardinal cut from the previous file is ' +
        'model-relative, the same reason resetViewerState already clears the in-memory ' +
        'axis/position/flipped',
    );
  });

  it('leaves the cap appearance preferences alone', () => {
    // Those are display style, not geometry, and the reset preserves them
    // deliberately -- clobbering them caused "my hatch / colour resets to
    // defaults every time I open a file". Without this, a fix that cleared
    // every section key would look identical to a correct one.
    localStorage.setItem('ifc-lite:section-cap-style', '"diagonal"');
    localStorage.setItem('ifc-lite:section-cap-show', 'true');
    localStorage.setItem('ifc-lite:section-outlines-show', 'false');

    useViewerStore.getState().resetViewerState();

    assert.equal(localStorage.getItem('ifc-lite:section-cap-style'), '"diagonal"');
    assert.equal(localStorage.getItem('ifc-lite:section-cap-show'), 'true');
    assert.equal(localStorage.getItem('ifc-lite:section-outlines-show'), 'false');
  });
});
