/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `mutationSlice`'s contribution to the store-wide teardown seam
 * (`store/teardown.ts`). Split out beside the slice for the reason
 * `modelSlice.teardown.ts` documents.
 *
 * Session reset ONLY. `removeModel` discards the removed model's mutation
 * footprint through `clearMutations` / `clearMutationView`, which are existing,
 * separately-tested, per-model actions with ordering of their own — they stay
 * in the entry point, and `mutationViews` must NOT be added to a
 * 'model-removed' arm here.
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';

export const mutationTeardown = defineSliceTeardown(
  'mutationSlice',
  [
    'mutationViews',
    'changeSets',
    'activeChangeSetId',
    'undoStacks',
    'redoStacks',
    'dirtyModels',
    'mutationVersion',
  ],
  {
    // Mutations - clear all mutation state so stale changes don't carry over
    'session-reset': (_scope, state) => ({
      mutationViews: new Map(),
      changeSets: new Map(),
      activeChangeSetId: null,
      undoStacks: new Map(),
      redoStacks: new Map(),
      dirtyModels: new Set<string>(),
      // DELIBERATE difference from this slice's initial value (`0`): the reset
      // BUMPS the version rather than zeroing it. It is the one derived value
      // in the whole table — every consumer keyed on it re-reads when it moves,
      // and rewinding to 0 could land on a number a consumer has already seen.
      // It always differs from the current value, so the composition never
      // drops it. Session reset only: bumping it on every model removal would
      // be a behaviour change, not a restructuring.
      mutationVersion: (state.mutationVersion ?? 0) + 1,
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
