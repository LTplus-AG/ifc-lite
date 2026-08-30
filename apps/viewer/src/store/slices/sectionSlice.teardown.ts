/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `sectionSlice`'s answer to "what do I destroy under this scope".
 *
 * Beside the slice rather than inside it because `sectionSlice.ts` sits at its
 * recorded module-size budget (`scripts/module-size-allowlist.txt`), which
 * ratchets down by default.
 *
 * This is the store's canonical Trap B: ONE value, `sectionPlane`, holds both
 * session-scoped and persisted fields. Rather than spread the live plane and
 * overwrite each session-scoped field by name — which is how #3365 happened,
 * `custom` being model-relative geometry that nobody remembered to list next
 * to `axis`/`position`/`enabled`/`flipped` — this builds the result as an
 * ALLOWLIST: start from the slice's own defaults (every field session-scoped
 * by construction) and carry forward only the three fields that are
 * genuinely persisted. A future field added to `SectionPlane` therefore
 * defaults to CLEARED on a session reset unless someone deliberately opts it
 * into the keep-list below, instead of silently surviving the way `custom`
 * did.
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

import { defineSliceTeardown, notApplicable } from '../teardown.js';
import { getDefaultSectionPlane } from './sectionSlice.js';

export const sectionTeardown = defineSliceTeardown(
  'sectionSlice',
  ['sectionPlane'],
  {
    'session-reset': (_scope, state) => {
      // The `??` is for the partial-store harness (`TeardownState` is a
      // `Partial<ViewerState>`): with no live plane to read from, the slice's
      // own initial value is by definition the right answer for the fields
      // being kept too.
      const live = state.sectionPlane ?? getDefaultSectionPlane();

      return {
        // Keep ONLY the user's cut-surface appearance preferences — showCap,
        // showOutlines, capStyle. Those round-trip to localStorage via the
        // slice's persistence helpers; clobbering them here was the cause of
        // "my hatch / colour resets to defaults every time I open a file".
        // Everything else (axis, position, enabled, flipped, custom) is
        // model-relative and meaningless against a different model, so it
        // comes from `getDefaultSectionPlane()` rather than being spread from
        // `live` and then patched field by field.
        sectionPlane: {
          ...getDefaultSectionPlane(),
          showCap:      live.showCap,
          showOutlines: live.showOutlines,
          capStyle:     live.capStyle,
        },
      };
    },
    // A cut plane is positioned against the whole loaded scene, not against
    // one model, so neither removing a model nor clearing them all moves it.
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
