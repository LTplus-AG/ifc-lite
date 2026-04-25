/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Search state slice.
 *
 * Two surfaces — both backed by the same per-model Tier-1 indexes:
 *   1. Inline toolbar field (Tier-0/Tier-1 fuzzy text scan).
 *   2. Advanced modal with two tabs:
 *        - Search: same Tier-0/Tier-1 scan, virtualised + chip filters
 *          (matchField, model include).
 *        - Filter: chip-based structured rules over the unified
 *          `FilterRule[]` shape, evaluated by the in-memory path-B
 *          evaluator. No DuckDB — Builder + run is the whole UI.
 *
 * The path-B evaluator is the only run path; the previous DuckDB
 * editor / SQL emitter / Run SQL button were removed once it became
 * clear the in-memory engine handles 4M-entity models with the index
 * prefilter + cheap-first ordering + chunked yielding pattern.
 */

import type { StateCreator } from 'zustand';
import type { Tier1Index } from '@/lib/search/tier1-index';
import type { SearchResult, MatchField } from '@/lib/search/tier0-scan';
import type { FilterRule, Combinator } from '@/lib/search/filter-rules';
import type { FilterSchema, PsetQtoSchema } from '@/lib/search/filter-schema';

/** Index lifecycle state for a single model. */
export type Tier1IndexStatus = 'pending' | 'building' | 'ready' | 'error';

export interface Tier1IndexRecord {
  status: Tier1IndexStatus;
  /** Only present when status === 'ready'. */
  index?: Tier1Index;
  /** Progress in [0, 1] while status === 'building'. */
  progress?: number;
  /** Diagnostic message when status === 'error'. */
  error?: string;
}

/**
 * Vim-style search cycle — enters on Enter-commit from the inline field.
 * While active, `n` / `N` step through the frozen result list, framing
 * each match, and a small hint badge is shown near the search field.
 * Any typing, Esc, or clicking elsewhere exits the cycle.
 */
export interface SearchVimCycleState {
  /** The query string at the moment of commit (shown in the hint). */
  query: string;
  /** Frozen snapshot of results at commit; stable for the cycle's lifetime. */
  results: SearchResult[];
  /** 0-based index of the currently selected result. */
  index: number;
}

/**
 * Chip filter for the advanced modal — narrows results to rows whose
 * `matchField` equals the selected value, or 'all' for no restriction.
 */
export type SearchFieldFilter = MatchField | 'all';

/**
 * Tabular result from a Filter run. Flat snapshot so the modal can
 * re-render rows without holding live evaluator state.
 */
export interface SearchFilterResult {
  columns: string[];
  rows: unknown[][];
  runMs: number;
}

/**
 * Unified filter state — chip rules + AND/OR + result cap. Drives the
 * path-B evaluator in `lib/search/filter-evaluate.ts`.
 */
export interface SearchFilterStateValue {
  rules: FilterRule[];
  combinator: Combinator;
  /** Result cap. `0` = no cap (evaluator's internal default applies). */
  limit: number;
}

export function emptyFilterState(): SearchFilterStateValue {
  return { rules: [], combinator: 'AND', limit: 500 };
}

/**
 * Per-model filter-schema cache for chip dropdowns. Populated on demand
 * when the modal opens; cleared when a model is removed.
 */
export interface FilterSchemaCacheEntry {
  /** Cheap pass — storeys + ifcTypes. Always populated when entry exists. */
  basic: FilterSchema;
  /** Expensive pass — pset / qto names. Lazy; null until first request. */
  psetQto: PsetQtoSchema | null;
}

export interface SearchSlice {
  /** Current input value (debounced consumers may stage their own copy). */
  searchQuery: string;
  /** Popover open below the inline field. */
  searchOpen: boolean;
  /** Currently highlighted result index in the popover (arrow-key nav). */
  searchHighlightIndex: number;
  /** Per-model Tier-1 index lifecycle (modelId → record). */
  searchIndexes: Map<string, Tier1IndexRecord>;
  /** Active vim-style cycle, or null when not cycling. */
  searchVimCycle: SearchVimCycleState | null;
  /** Advanced search modal (⌘⇧F) is open. */
  searchModalOpen: boolean;
  /** Field chip filter active inside the modal. Defaults to 'all'. */
  searchFieldFilter: SearchFieldFilter;
  /** Per-modelId include filter inside the modal. `null` means all models included. */
  searchModelFilter: Set<string> | null;

  /** Latest Filter run result (or null on fresh tab open / error). */
  searchFilterResult: SearchFilterResult | null;
  /** Whether a Filter run is currently in flight. */
  searchFilterRunning: boolean;
  /** Latest Filter error message — set when the evaluator throws. */
  searchFilterError: string | null;
  /** Filter rule state — chip rules, combinator, limit. */
  searchFilter: SearchFilterStateValue;
  /** Per-model filter-schema cache (lazy). */
  searchFilterSchema: Map<string, FilterSchemaCacheEntry>;

  setSearchQuery: (query: string) => void;
  setSearchOpen: (open: boolean) => void;
  setSearchHighlightIndex: (index: number) => void;
  /** Convenience: close popover and reset highlight (preserves query). */
  closeSearch: () => void;
  /** Convenience: clear query and close popover. */
  resetSearch: () => void;

  /** Replace (or insert) the index record for a model. */
  setSearchIndexRecord: (modelId: string, record: Tier1IndexRecord) => void;
  /** Drop the index record for a model (called when a model is removed). */
  removeSearchIndexRecord: (modelId: string) => void;

  /** Enter vim cycle mode with a frozen result snapshot at `index`. */
  enterVimCycle: (query: string, results: SearchResult[], index: number) => void;
  /** Exit vim cycle mode (no-op when inactive). */
  exitVimCycle: () => void;
  /** Advance the cycle by +1 / -1, wrapping around. */
  stepVimCycle: (delta: 1 | -1) => void;

  setSearchModalOpen: (open: boolean) => void;
  toggleSearchModal: () => void;
  setSearchFieldFilter: (filter: SearchFieldFilter) => void;
  /** Toggle a model in/out of the include filter. If the filter is null,
   *  the first toggle materialises it as "all models except this one". */
  toggleSearchModelFilter: (modelId: string, availableModelIds: readonly string[]) => void;
  /** Clear model filter (null → all models included). */
  clearSearchModelFilter: () => void;

  // ── Filter run state ──────────────────────────────────────────────
  setSearchFilterRunning: (running: boolean) => void;
  /** Successful run — sets the result and clears any prior error
   *  (the new run supersedes the old failure). */
  setSearchFilterResult: (result: SearchFilterResult | null) => void;
  /** Error path — keeps the prior result visible while showing the
   *  error above it (notebook-style pairing). */
  setSearchFilterError: (error: string | null) => void;

  // ── Filter-rule actions ───────────────────────────────────────────
  /** Replace the whole filter state — used by Reset and preset loading. */
  setSearchFilter: (state: SearchFilterStateValue) => void;
  setFilterCombinator: (combinator: Combinator) => void;
  setFilterLimit: (limit: number) => void;
  addFilterRule: (rule: FilterRule) => void;
  updateFilterRule: (index: number, rule: FilterRule) => void;
  removeFilterRule: (index: number) => void;
  /** Drop every rule but keep combinator + limit. */
  clearFilterRules: () => void;

  // ── Schema cache actions ──────────────────────────────────────────
  setFilterSchema: (modelId: string, basic: FilterSchema) => void;
  setFilterPsetQtoSchema: (modelId: string, psetQto: PsetQtoSchema) => void;
  removeFilterSchema: (modelId: string) => void;
}

export const createSearchSlice: StateCreator<SearchSlice, [], [], SearchSlice> = (set) => ({
  searchQuery: '',
  searchOpen: false,
  searchHighlightIndex: 0,
  searchIndexes: new Map(),
  searchVimCycle: null,
  searchModalOpen: false,
  searchFieldFilter: 'all',
  searchModelFilter: null,
  searchFilterResult: null,
  searchFilterRunning: false,
  searchFilterError: null,
  searchFilter: emptyFilterState(),
  searchFilterSchema: new Map(),

  // Typing or programmatically changing the query breaks out of vim cycle —
  // the user is re-searching, not stepping through a committed result list.
  setSearchQuery: (searchQuery) => set({ searchQuery, searchHighlightIndex: 0, searchVimCycle: null }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setSearchHighlightIndex: (searchHighlightIndex) => set({ searchHighlightIndex }),

  closeSearch: () => set({ searchOpen: false, searchHighlightIndex: 0 }),
  resetSearch: () =>
    set({ searchQuery: '', searchOpen: false, searchHighlightIndex: 0, searchVimCycle: null }),

  setSearchIndexRecord: (modelId, record) =>
    set((state) => {
      const next = new Map(state.searchIndexes);
      next.set(modelId, record);
      return { searchIndexes: next };
    }),

  removeSearchIndexRecord: (modelId) =>
    set((state) => {
      if (!state.searchIndexes.has(modelId)) return {};
      const next = new Map(state.searchIndexes);
      next.delete(modelId);
      return { searchIndexes: next };
    }),

  enterVimCycle: (query, results, index) => {
    if (results.length === 0) return;
    const clamped = Math.max(0, Math.min(index, results.length - 1));
    set({ searchVimCycle: { query, results, index: clamped } });
  },

  exitVimCycle: () => set({ searchVimCycle: null }),

  stepVimCycle: (delta) =>
    set((state) => {
      const cycle = state.searchVimCycle;
      if (!cycle || cycle.results.length === 0) return {};
      const len = cycle.results.length;
      const next = (cycle.index + delta + len) % len;
      return { searchVimCycle: { ...cycle, index: next } };
    }),

  setSearchModalOpen: (searchModalOpen) => set({ searchModalOpen }),
  toggleSearchModal: () => set((state) => ({ searchModalOpen: !state.searchModalOpen })),
  setSearchFieldFilter: (searchFieldFilter) => set({ searchFieldFilter }),

  toggleSearchModelFilter: (modelId, availableModelIds) =>
    set((state) => {
      const current = state.searchModelFilter;
      // First toggle from the "all included" null state materialises an
      // explicit set containing every OTHER model — checking the box that
      // was "on by default" and unchecking it feels the same to the user.
      if (current === null) {
        const next = new Set(availableModelIds);
        next.delete(modelId);
        return { searchModelFilter: next };
      }
      const next = new Set(current);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      // Prune ids that no longer correspond to live models. Without
      // this, the persisted set accumulates garbage entries across
      // model load/unload cycles — every removed model leaves its id
      // in `next` permanently because the collapse check below only
      // walks `availableModelIds` and never sees the orphan.
      const availSet = new Set(availableModelIds);
      for (const id of Array.from(next)) {
        if (!availSet.has(id)) next.delete(id);
      }
      // If the user has re-included every available model, collapse back
      // to null so the "all included" default re-applies when a new model
      // loads later.
      let allIncluded = true;
      for (const id of availableModelIds) {
        if (!next.has(id)) { allIncluded = false; break; }
      }
      return { searchModelFilter: allIncluded ? null : next };
    }),

  clearSearchModelFilter: () => set({ searchModelFilter: null }),

  setSearchFilterRunning: (searchFilterRunning) => set({ searchFilterRunning }),
  // Notebook-style pairing: a successful run clears the prior error
  // (new result supersedes failure) but an error keeps the prior result
  // on screen so the user doesn't lose their last good table while
  // debugging.
  setSearchFilterResult: (searchFilterResult) => set({ searchFilterResult, searchFilterError: null }),
  setSearchFilterError: (searchFilterError) => set({ searchFilterError }),

  setSearchFilter: (searchFilter) => set({ searchFilter }),

  setFilterCombinator: (combinator) =>
    set((state) => ({ searchFilter: { ...state.searchFilter, combinator } })),

  setFilterLimit: (limit) =>
    set((state) => ({ searchFilter: { ...state.searchFilter, limit } })),

  addFilterRule: (rule) =>
    set((state) => ({
      searchFilter: {
        ...state.searchFilter,
        rules: [...state.searchFilter.rules, rule],
      },
    })),

  updateFilterRule: (index, rule) =>
    set((state) => {
      const rules = state.searchFilter.rules;
      if (index < 0 || index >= rules.length) return {};
      const next = rules.slice();
      next[index] = rule;
      return { searchFilter: { ...state.searchFilter, rules: next } };
    }),

  removeFilterRule: (index) =>
    set((state) => {
      const rules = state.searchFilter.rules;
      if (index < 0 || index >= rules.length) return {};
      const next = rules.slice();
      next.splice(index, 1);
      return { searchFilter: { ...state.searchFilter, rules: next } };
    }),

  clearFilterRules: () =>
    set((state) => ({ searchFilter: { ...state.searchFilter, rules: [] } })),

  setFilterSchema: (modelId, basic) =>
    set((state) => {
      const next = new Map(state.searchFilterSchema);
      const existing = next.get(modelId);
      next.set(modelId, { basic, psetQto: existing?.psetQto ?? null });
      return { searchFilterSchema: next };
    }),

  setFilterPsetQtoSchema: (modelId, psetQto) =>
    set((state) => {
      const next = new Map(state.searchFilterSchema);
      const existing = next.get(modelId);
      // Only meaningful once a basic schema has been set — the modal
      // calls discoverFilterSchema first then queues the heavy pass.
      if (!existing) return {};
      next.set(modelId, { basic: existing.basic, psetQto });
      return { searchFilterSchema: next };
    }),

  removeFilterSchema: (modelId) =>
    set((state) => {
      if (!state.searchFilterSchema.has(modelId)) return {};
      const next = new Map(state.searchFilterSchema);
      next.delete(modelId);
      return { searchFilterSchema: next };
    }),
});
