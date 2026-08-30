/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `visibilitySlice`'s contribution to the store-wide teardown seam
 * (`store/teardown.ts`). Split out beside the slice for the reason
 * `modelSlice.teardown.ts` documents.
 *
 * This slice owns the two SHARED channels — `isolatedEntities` /
 * `ghostExceptEntities` — that `store/visibility-invalidation.ts` guards. The
 * patch this function returns must therefore reach the store through the
 * WRAPPED `set` / `setState` every other write goes through, so the ownership
 * invalidation fires for a teardown write exactly as it does for any other. A
 * teardown never applies its own patch; the entry point does.
 *
 * Two rules the bodies below are built around:
 *
 *  - an isolate / ghost / class filter left with zero surviving ids clears to
 *    `null` outright, NEVER to an empty `Set` — a non-null empty set still
 *    reads as "isolation active, nothing matches" and hides everything;
 *  - `typeVisibility` / `typeViewMode` are RE-READ from localStorage on a
 *    session reset (Trap B), not zeroed, and are absent from the two
 *    federation arms entirely.
 */

import { defineSliceTeardown } from '../teardown.js';
import { getPersistedTypeVisibility, getPersistedTypeViewMode } from '../constants.js';

export const visibilityTeardown = defineSliceTeardown(
  'visibilitySlice',
  [
    'hiddenEntities',
    'isolatedEntities',
    'ghostExceptEntities',
    'classFilter',
    'typeVisibility',
    'typeViewMode',
    'hiddenEntitiesByModel',
    'isolatedEntitiesByModel',
  ],
  {
    'session-reset': () => ({
      // Visibility (legacy)
      hiddenEntities: new Set<number>(),
      isolatedEntities: null,
      ghostExceptEntities: null,
      classFilter: null,
      // Re-read persisted toggles on every file load so a new model never
      // reverts the user's visibility choices (e.g. "Show Annotations").
      typeVisibility: getPersistedTypeVisibility(),
      typeViewMode: getPersistedTypeViewMode(),

      // Visibility (multi-model)
      hiddenEntitiesByModel: new Map(),
      isolatedEntitiesByModel: new Map(),
    }),
    // With zero survivors every id is stale by definition, so this clears
    // unconditionally rather than repeating the range check for an
    // always-true answer. `isolatedEntities` / `ghostExceptEntities` clear to
    // `null` (not an empty `Set`) for the reason the 'model-removed' arm
    // below spells out — an empty-but-set isolate would hide the very next
    // model loaded, until it does. `typeVisibility` / `typeViewMode` are NOT
    // here: they are the user's persisted preferences, not scene state, and
    // `clearAllModels` has never touched them.
    'all-models-cleared': () => ({
      hiddenEntities: new Set<number>(),
      isolatedEntities: null,
      ghostExceptEntities: null,
      classFilter: null,
      hiddenEntitiesByModel: new Map(),
      isolatedEntitiesByModel: new Map(),
    }),
    'model-removed': (scope, state) => {
      const { modelId, isStale } = scope;

      // These key off `globalId`, not `modelId`. A global id is "stale" once no
      // SURVIVING model's parse range or overlay owns it — the predicate the
      // scope carries, computed once by the entry point. Left unpurged, an
      // isolate or ghost set that only ever named the removed model's entities
      // stays non-null while matching nothing in the survivors, so
      // `effectiveIsolatedIds` keeps returning it and the entire remaining
      // federation renders as hidden — worse than the id merely dangling.
      const priorHidden = state.hiddenEntities;
      const priorIsolated = state.isolatedEntities;
      const priorGhost = state.ghostExceptEntities;
      const priorClassFilter = state.classFilter;
      const touched =
        (priorHidden !== undefined && [...priorHidden].some(isStale)) ||
        (priorIsolated != null && [...priorIsolated].some(isStale)) ||
        (priorGhost != null && [...priorGhost].some(isStale)) ||
        (priorClassFilter != null && [...priorClassFilter.ids].some(isStale)) ||
        state.hiddenEntitiesByModel?.has(modelId) === true ||
        state.isolatedEntitiesByModel?.has(modelId) === true;

      // Nothing of ours named the removed model. Returning {} rather than a set
      // of equal-but-new collections is what keeps this scope idempotent:
      // `syncSourceModel` runs it a second time straight after
      // `removeModel`, and a fresh `isolatedEntities` reference would put the
      // channel through `withVisibilityOwnershipInvalidation` again for a set
      // that did not move.
      if (!touched) return {};

      return {
        hiddenEntities: priorHidden
          ? new Set([...priorHidden].filter((id) => !isStale(id)))
          : priorHidden,
        // An isolate/ghost set left with zero surviving ids must clear to `null`
        // outright, not an empty `Set` — a non-null empty set still reads as
        // "isolation active, nothing matches" and hides every remaining entity,
        // same as the stale set it replaces.
        isolatedEntities: priorIsolated ? nonEmptyOrNull(priorIsolated, isStale) : priorIsolated,
        ghostExceptEntities: priorGhost ? nonEmptyOrNull(priorGhost, isStale) : priorGhost,
        // The Class-tab filter intersects into the visible set: left unpurged it
        // would hold only burned ids after a sync, matching nothing — every
        // element of the reloaded model would disappear. An emptied filter clears
        // entirely.
        classFilter: priorClassFilter
          ? (() => {
              const kept = new Set([...priorClassFilter.ids].filter((id) => !isStale(id)));
              return kept.size > 0 ? { ids: kept, label: priorClassFilter.label } : null;
            })()
          : priorClassFilter,
        hiddenEntitiesByModel: priorMapWithout(state.hiddenEntitiesByModel, modelId),
        isolatedEntitiesByModel: priorMapWithout(state.isolatedEntitiesByModel, modelId),
      };
    },
  },
);

/** Drop every stale id; collapse an emptied set to `null` rather than `Set{}`. */
function nonEmptyOrNull(
  prior: ReadonlySet<number>,
  isStale: (id: number) => boolean,
): Set<number> | null {
  const kept = new Set([...prior].filter((id) => !isStale(id)));
  return kept.size > 0 ? kept : null;
}

/** A copy of `prior` without `modelId`, or `prior` itself when it is absent. */
function priorMapWithout(
  prior: Map<string, Set<number>> | undefined,
  modelId: string,
): Map<string, Set<number>> | undefined {
  if (!prior) return prior;
  const next = new Map(prior);
  next.delete(modelId);
  return next;
}
