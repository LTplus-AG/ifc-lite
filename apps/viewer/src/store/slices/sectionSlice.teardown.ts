/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `sectionSlice`'s answer to "what do I destroy under this scope".
 *
 * Beside the slice rather than inside it because `sectionSlice.ts` sits at its
 * recorded module-size budget (`scripts/module-size-allowlist.txt`), which
 * ratchets down only.
 *
 * This is the store's canonical Trap B: ONE value, `sectionPlane`, holds both
 * session-scoped and persisted fields, so the teardown spreads the live plane
 * instead of replacing it. See the field comment below.
 *
 * `sectionPickMode` and `sectionPickPreview` are NOT reset by any of today's
 * four teardown paths, so they are absent from both `owns` and the body.
 *
 * `resetSectionPlane` is deliberately NOT folded into this: it means "give me
 * the defaults back", and to do that it REMOVES the persisted cap keys from
 * localStorage — the exact opposite of what a file swap must do. Different
 * semantics, so it stays its own action.
 *
 * `clearLastSectionMode()` (localStorage, #2939) is an ordered side effect and
 * stays at the entry point in `store/index.ts`; a teardown is pure.
 */

import { defineSliceTeardown } from '../teardown.js';
import { SECTION_PLANE_DEFAULTS } from '../constants.js';
import { getDefaultSectionPlane } from './sectionSlice.js';

export const sectionTeardown = defineSliceTeardown(
  'sectionSlice',
  ['sectionPlane'],
  (scope, state) => {
    // A cut plane is positioned against the whole loaded scene, not against
    // one model, so neither removing a model nor clearing them all moves it.
    if (scope.kind !== 'session-reset') return {};

    return {
      // Section plane: reset axis/position/enabled/flipped (those are
      // model-relative and meaningless when switching files), but PRESERVE
      // the user's cap appearance preferences (showCap, showOutlines,
      // capStyle). Those round-trip to localStorage via the slice's
      // persistence helpers; clobbering them here was the cause of "my
      // hatch / colour resets to defaults every time I open a file".
      //
      // The `??` is for the partial-store harness (`TeardownState` is a
      // `Partial<ViewerState>`): with no live plane to spread, the slice's own
      // initial value is by definition the right answer, and it re-reads the
      // same persisted fields.
      sectionPlane: {
        ...(state.sectionPlane ?? getDefaultSectionPlane()),
        axis:     SECTION_PLANE_DEFAULTS.AXIS,
        position: SECTION_PLANE_DEFAULTS.POSITION,
        enabled:  SECTION_PLANE_DEFAULTS.ENABLED,
        flipped:  SECTION_PLANE_DEFAULTS.FLIPPED,
      },
    };
  },
);
