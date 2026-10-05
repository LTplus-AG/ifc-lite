/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Result selection (U02, #6925). A result row can be in three distinct states,
 * and they never stand in for one another:
 *
 *   highlighted   the one row the user is looking at (the focused finding whose
 *                 evidence and 3D target are shown). Owned by the panel's
 *                 existing focus (e.g. the clash store's `selectedId`), not
 *                 by this reducer; it never changes membership.
 *   selected      what the next bulk action applies to.
 *   included      the rows pinned into a prepared batch. Copied from the
 *                 selection on an explicit "include" and NEVER recomputed from
 *                 filters or a later selection: changing a filter does not
 *                 silently change a batch that was already prepared.
 *
 * "Select all" records which population it meant. `page` is the rows loaded
 * on screen; `population` is every row matching the current filters, which
 * can be larger than what is loaded, so its keys are retrieved from the
 * authoritative source first. Until that retrieval resolves, a
 * complete-population action stays disabled (`canActOnPopulation`). A late
 * answer for an older request is dropped.
 *
 * Pure reducer: no React, no store. Keys are the caller's stable row ids.
 */

export type SelectAll =
  | { scope: 'page'; count: number }
  | { scope: 'population'; state: 'resolving' | 'failed'; total: number; request: number }
  | { scope: 'population'; state: 'resolved'; total: number; request: number };

export interface ResultSelection {
  selected: ReadonlySet<string>;
  included: ReadonlySet<string>;
  /** How the current selection was made by "Select all"; null for individual picks. */
  selectAll: SelectAll | null;
  /** Monotonic id of the latest population request. */
  requests: number;
}

export const EMPTY_SELECTION: ResultSelection = {
  selected: new Set(), included: new Set(), selectAll: null, requests: 0,
};

export type SelectionAction =
  | { type: 'toggle'; key: string }
  /** `complete`: the loaded page IS the whole matching population, so its keys are authoritative. */
  | { type: 'selectPage'; keys: readonly string[]; complete?: boolean }
  | { type: 'requestPopulation'; total: number }
  | { type: 'populationResolved'; request: number; keys: readonly string[] }
  | { type: 'populationFailed'; request: number }
  | { type: 'clear' }
  | { type: 'include' }
  | { type: 'exclude'; key: string }
  | { type: 'clearBatch' }
  /** Filters or the result changed: a selection made over the old population no longer names it. */
  | { type: 'populationChanged' };

export function reduceSelection(state: ResultSelection, action: SelectionAction): ResultSelection {
  switch (action.type) {
    case 'toggle': {
      const selected = new Set(state.selected);
      if (selected.has(action.key)) selected.delete(action.key);
      else selected.add(action.key);
      return { ...state, selected, selectAll: null };
    }
    case 'selectPage':
      return {
        ...state,
        selected: new Set(action.keys),
        selectAll: action.complete
          ? { scope: 'population', state: 'resolved', total: action.keys.length, request: state.requests }
          : { scope: 'page', count: action.keys.length },
      };
    case 'requestPopulation': {
      const request = state.requests + 1;
      return { ...state, requests: request, selectAll: { scope: 'population', state: 'resolving', total: action.total, request } };
    }
    case 'populationResolved': {
      if (state.selectAll?.scope !== 'population' || state.selectAll.request !== action.request) return state;
      return {
        ...state,
        selected: new Set(action.keys),
        selectAll: { scope: 'population', state: 'resolved', total: action.keys.length, request: action.request },
      };
    }
    case 'populationFailed': {
      if (state.selectAll?.scope !== 'population' || state.selectAll.request !== action.request) return state;
      return { ...state, selectAll: { ...state.selectAll, state: 'failed' } };
    }
    case 'clear':
      return { ...state, selected: new Set(), selectAll: null };
    case 'include':
      // A population still resolving has no authoritative members to pin.
      if (state.selectAll?.scope === 'population' && state.selectAll.state !== 'resolved') return state;
      return { ...state, included: new Set(state.selected) };
    case 'exclude': {
      if (!state.included.has(action.key)) return state;
      const included = new Set(state.included);
      included.delete(action.key);
      return { ...state, included };
    }
    case 'clearBatch':
      return { ...state, included: new Set() };
    case 'populationChanged':
      // Individual picks survive a filter change; a "select all" over the old
      // population does not, because it no longer means what it said.
      return state.selectAll ? { ...state, selected: new Set(), selectAll: null } : state;
  }
}

/** A complete-population action may run only over retrieved, authoritative keys. */
export function canActOnPopulation(state: ResultSelection): boolean {
  return state.selectAll?.scope === 'population' && state.selectAll.state === 'resolved';
}

/** Whether a selection-scoped action has anything authoritative to act on. */
export function canActOnSelection(state: ResultSelection): boolean {
  if (state.selectAll?.scope === 'population') return canActOnPopulation(state) && state.selected.size > 0;
  return state.selected.size > 0;
}
