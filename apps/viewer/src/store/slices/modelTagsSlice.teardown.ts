/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `modelTagsSlice`'s contribution to the store-wide teardown seam
 * (`store/teardown.ts`), beside the slice like every other contribution.
 *
 * Only the ASSIGNMENTS are torn down. Tag definitions (`modelTags`) are the
 * user's vocabulary — persisted to localStorage, referenced by id from saved
 * advanced filters and clash presets — and a file swap must no more destroy
 * them than it destroys saved filters. An assignment, by contrast, names a
 * model id, and a model id that is gone must not keep a tag on it: the next
 * model handed the same id by a setup-file reopen would inherit tags it was
 * never given.
 */

import { defineSliceTeardown } from '../teardown.js';

export const modelTagsTeardown = defineSliceTeardown('modelTagsSlice', ['modelTagAssignments'], {
  'session-reset': () => ({ modelTagAssignments: new Map<string, ReadonlySet<string>>() }),
  'all-models-cleared': () => ({ modelTagAssignments: new Map<string, ReadonlySet<string>>() }),
  'model-removed': (scope, state) => {
    const prior = state.modelTagAssignments;
    if (!prior?.has(scope.modelId)) return {};
    const next = new Map(prior);
    next.delete(scope.modelId);
    return { modelTagAssignments: next };
  },
});
