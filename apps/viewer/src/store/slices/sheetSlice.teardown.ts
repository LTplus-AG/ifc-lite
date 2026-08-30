/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `sheetSlice`'s answer to "what do I destroy under this scope".
 *
 * Beside the slice rather than inside it because `sheetSlice.ts` sits at its
 * recorded module-size budget (`scripts/module-size-allowlist.txt`), which
 * ratchets down by default.
 *
 * `savedSheetTemplates` MUST SURVIVE and is absent from both `owns` and the
 * body. That is confirmed bug #1 in `scripts/check-whole-state-reset.mjs`'s
 * header (issue #2802): `clearSheet` did `set(getDefaultState())` and
 * destroyed the user's template library on every "clear" click. The values
 * below come from {@link getClearedSheetState}, the one explicit field list
 * `clearSheet` now also uses, so the two paths cannot drift apart again.
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';
import { getClearedSheetState } from './sheetSlice.js';

export const sheetTeardown = defineSliceTeardown(
  'sheetSlice',
  ['activeSheet', 'sheetEnabled', 'sheetPanelVisible', 'titleBlockEditorVisible'],
  {
    // `getClearedSheetState()` returns exactly these four keys — it is typed
    // `Omit<SheetState, 'savedSheetTemplates'>`, which is what keeps the user's
    // saved templates out of both this and `clearSheet` (#2802's first bug).
    // Destructuring and rebuilding it here would be a second list to keep in
    // step with the first.
    'session-reset': getClearedSheetState,
    // A sheet is a document laid out over the drawing, not a per-model
    // artefact: removing one model from a federation, or clearing them all,
    // leaves it alone. Only a file swap tears it down.
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
