/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The search slice's group-aware filter-rule actions (#4904).
 *
 * A sibling module rather than a block in `searchSlice.ts` for the same
 * reason `searchSlice.teardown.ts` is one: that file sits right at the
 * ~400-line module cap (`scripts/check-module-size.mjs`), and the
 * `groups: FilterGroup[]` rework (was flat `{ rules, combinator }`) added a
 * "which group is being edited" dimension every rule/combinator action now
 * has to route through — `updateActiveGroup` below is the one place that
 * routing lives, so `addFilterRule` etc. stay one-liners in `searchSlice.ts`.
 *
 * Pure functions of `(set)` → action, not slice methods themselves, so this
 * file has no dependency on `SearchSlice`'s full shape — only the two fields
 * (`searchFilter`, `searchFilterActiveGroup`) these actions touch — and
 * `searchSlice.ts` can import it as an ordinary (non-circular at runtime)
 * module: the only import going the other way, `SearchFilterStateValue`, is
 * `import type`, which TypeScript erases before either module executes.
 */

import type { FilterRule, Combinator } from '@/lib/search/filter-rules';
import { emptyFilterGroup, type FilterGroup } from '@/lib/search/filter-groups';
import type { SearchFilterStateValue } from './searchSlice.js';

interface GroupState {
  searchFilter: SearchFilterStateValue;
  searchFilterActiveGroup: number;
}

type SetFn = (
  fn: (state: GroupState) => Partial<GroupState>,
) => void;

export function clampGroupIndex(index: number, groupCount: number): number {
  if (groupCount <= 0) return 0;
  return Math.max(0, Math.min(index, groupCount - 1));
}

function activeGroup(state: GroupState): FilterGroup | undefined {
  return state.searchFilter.groups[clampGroupIndex(state.searchFilterActiveGroup, state.searchFilter.groups.length)];
}

/** Replace the active group in `state.searchFilter.groups` with `update(active)`,
 *  leaving every other group untouched. Every rule/combinator action below
 *  targets only the "currently open" group. */
function updateActiveGroup(state: GroupState, update: (group: FilterGroup) => FilterGroup): FilterGroup[] {
  const groups = state.searchFilter.groups;
  const i = clampGroupIndex(state.searchFilterActiveGroup, groups.length);
  const active = groups[i];
  if (!active) return groups;
  const next = groups.slice();
  next[i] = update(active);
  return next;
}

export interface FilterGroupActions {
  setFilterCombinator: (combinator: Combinator) => void;
  addFilterRule: (rule: FilterRule) => void;
  updateFilterRule: (index: number, rule: FilterRule) => void;
  removeFilterRule: (index: number) => void;
  clearFilterRules: () => void;
  /** Drop EVERY group back to one empty AND group, keeping the limit.
   *  Unlike `clearFilterRules` (active group only), this is what a caller
   *  with no per-group UI context — the inline toolbar's "Clear filters" —
   *  must use: it counts and displays rules across ALL groups (#4904), so
   *  its clear action has to actually empty all of them or the badge stays
   *  non-zero after the click (review, PR #4987). */
  clearAllFilterGroups: () => void;
  addFilterGroup: () => void;
  removeFilterGroup: (index: number) => void;
  setActiveFilterGroup: (index: number) => void;
}

export function createFilterGroupActions(set: SetFn): FilterGroupActions {
  return {
    setFilterCombinator: (combinator) =>
      set((state) => ({
        searchFilter: { ...state.searchFilter, groups: updateActiveGroup(state, (g) => ({ ...g, combinator })) },
      })),

    addFilterRule: (rule) =>
      set((state) => ({
        searchFilter: {
          ...state.searchFilter,
          groups: updateActiveGroup(state, (g) => ({ ...g, rules: [...g.rules, rule] })),
        },
      })),

    updateFilterRule: (index, rule) =>
      set((state) => {
        const active = activeGroup(state);
        if (!active || index < 0 || index >= active.rules.length) return {};
        return {
          searchFilter: {
            ...state.searchFilter,
            groups: updateActiveGroup(state, (g) => {
              const next = g.rules.slice();
              next[index] = rule;
              return { ...g, rules: next };
            }),
          },
        };
      }),

    removeFilterRule: (index) =>
      set((state) => {
        const active = activeGroup(state);
        if (!active || index < 0 || index >= active.rules.length) return {};
        return {
          searchFilter: {
            ...state.searchFilter,
            groups: updateActiveGroup(state, (g) => {
              const next = g.rules.slice();
              next.splice(index, 1);
              return { ...g, rules: next };
            }),
          },
        };
      }),

    clearFilterRules: () =>
      set((state) => ({
        searchFilter: { ...state.searchFilter, groups: updateActiveGroup(state, (g) => ({ ...g, rules: [] })) },
      })),

    clearAllFilterGroups: () =>
      set((state) => ({
        searchFilter: { ...state.searchFilter, groups: [emptyFilterGroup()] },
        searchFilterActiveGroup: 0,
      })),

    addFilterGroup: () =>
      set((state) => {
        const groups = [...state.searchFilter.groups, emptyFilterGroup()];
        return {
          searchFilter: { ...state.searchFilter, groups },
          searchFilterActiveGroup: groups.length - 1,
        };
      }),

    removeFilterGroup: (index) =>
      set((state) => {
        const groups = state.searchFilter.groups;
        // A filter always keeps at least one group — dropping the last one
        // would leave `addFilterRule` etc. with nothing to target.
        if (groups.length <= 1 || index < 0 || index >= groups.length) return {};
        const next = groups.slice();
        next.splice(index, 1);
        // The SAME logical group the user had open must stay open — review
        // (PR #4987): clamping the OLD numeric index alone is wrong once a
        // PRECEDING group is removed, because every group after `index`
        // shifts left by one but the active index does not. With A/B/C and
        // B active (index 1), removing A (index 0) must land on B, now at
        // index 0 — not silently re-clamp to whatever slid into index 1
        // (C). Only when the ACTIVE group itself is removed does a
        // neighbour take over, which `clampGroupIndex` already handles.
        const prevActive = state.searchFilterActiveGroup;
        const nextActive = index < prevActive ? prevActive - 1 : prevActive;
        return {
          searchFilter: { ...state.searchFilter, groups: next },
          searchFilterActiveGroup: clampGroupIndex(nextActive, next.length),
        };
      }),

    setActiveFilterGroup: (index) =>
      set((state) => ({
        searchFilterActiveGroup: clampGroupIndex(index, state.searchFilter.groups.length),
      })),
  };
}
