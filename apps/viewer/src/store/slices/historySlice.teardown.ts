/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `historySlice`'s contribution to the store-wide teardown seam.
 *
 * Everything owned here is keyed by a VIEWER MODEL ID, which is exactly why
 * it must be torn down with the model: an id is reused by a setup-file
 * reopen, and a surviving commit tag would tell the panel that a brand-new
 * model is some other project's commit — with `isHistoricalModel` then
 * silently making it read-only, a bug with no visible cause.
 *
 * The panel's OPEN/CLOSED state is not here and is not this slice's at all:
 * the History panel is flag-free and the docked slot is `sidebarActivePanel`,
 * which no other panel's teardown touches either — where the user left their
 * workspace is not model state.
 */

import { defineSliceTeardown } from '../teardown.js';
import type { CommitTag, LocalLineageLink } from './historySlice.js';

function emptyState() {
  return {
    commitTags: new Map<string, CommitTag>() as ReadonlyMap<string, CommitTag>,
    localLineage: new Map<string, LocalLineageLink>() as ReadonlyMap<string, LocalLineageLink>,
    historyNewHeads: new Map<string, string>() as ReadonlyMap<string, string>,
    historyFocusModelId: null,
    historyPickA: null,
    historyPickB: null,
  };
}

export const historyTeardown = defineSliceTeardown(
  'historySlice',
  ['commitTags', 'localLineage', 'historyNewHeads', 'historyFocusModelId', 'historyPickA', 'historyPickB'],
  {
    'session-reset': emptyState,
    'all-models-cleared': emptyState,
    'model-removed': (scope, state) => {
      const commitTags = state.commitTags ?? new Map();
      const localLineage = state.localLineage ?? new Map();
      const newHeads = state.historyNewHeads ?? new Map();
      const focusGone = state.historyFocusModelId === scope.modelId;

      // A local lineage link names ANOTHER model as its base, so removing that
      // base leaves a link pointing at nothing — dropped here as well as the
      // removed model's own entry.
      const staleLineage = [...localLineage].filter(
        ([modelId, link]) => modelId === scope.modelId || link.baseModelId === scope.modelId,
      );

      return {
        ...(commitTags.has(scope.modelId)
          ? { commitTags: new Map([...commitTags].filter(([id]) => id !== scope.modelId)) }
          : {}),
        ...(staleLineage.length > 0
          ? { localLineage: new Map([...localLineage].filter(([id]) => !staleLineage.some(([stale]) => stale === id))) }
          : {}),
        ...(newHeads.has(scope.modelId)
          ? { historyNewHeads: new Map([...newHeads].filter(([id]) => id !== scope.modelId)) }
          : {}),
        // Focus follows the model: the panel falls back to its "open a model"
        // state rather than showing a timeline for something no longer loaded.
        ...(focusGone ? { historyFocusModelId: null, historyPickA: null, historyPickB: null } : {}),
      };
    },
  },
);
