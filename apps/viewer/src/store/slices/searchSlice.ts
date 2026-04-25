/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Search state slice
 *
 * Inline-toolbar search bar state — query string, popover visibility,
 * keyboard-navigation index, plus the per-model Tier-1 search indexes
 * built post-load. The actual scan results are derived in SearchInline
 * via useMemo; keeping derived results out of the store avoids needless
 * re-renders elsewhere.
 *
 * Tier hierarchy:
 *   Tier-0 — linear scan over already-cached EntityTable columns
 *            (zero build cost; fallback while Tier-1 is building)
 *   Tier-1 — per-model inverted token index built after load
 *            (zero load hot-path cost; yielded in chunks)
 *   Tier-2 — path-B FilterRule[] runtime evaluator (no DuckDB needed)
 *   Tier-3 — DuckDB SQL (handled in the modal, layered on top)
 *
 * Tier-2 and Tier-3 share the unified `FilterRule[]` shape (see
 * `lib/search/filter-rules.ts`) so the chip builder can dispatch to
 * either engine without rebuilding state.
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
 * Result from the most recent SQL run — kept as a flat snapshot so the
 * modal can re-render rows without holding onto the DuckDB row
 * iterators.
 */
export interface SearchSqlResult {
  columns: string[];
  rows: unknown[][];
  runMs: number;
}

/**
 * Sub-mode inside the SQL tab — Builder (chip UI) or Editor (raw SQL).
 * Flipping Builder → Editor copies the generated SQL into the editor as
 * a starting point; flipping back is read-only.
 */
export type SearchSqlMode = 'builder' | 'editor';

/**
 * Unified filter state — the single source of truth for the chip
 * builder. Both the SQL emitter (`generateSqlFromFilterRules`) and the
 * path-B evaluator (`evaluateFilterRulesFederated`) read this shape, so
 * the user can switch engines at run time without re-entering rules.
 */
export interface SearchFilterState {
  rules: FilterRule[];
  combinator: Combinator;
  /** Result cap. `0` = no LIMIT (skipped in SQL, ~5k default in path-B). */
  limit: number;
}

export function emptyFilterState(): SearchFilterState {
  return { rules: [], combinator: 'AND', limit: 500 };
}

/**
 * Per-model schema cache for chip dropdowns. Populated on demand by the
 * builder UI when the modal opens; cleared when a model is removed.
 */
export interface FilterSchemaCacheEntry {
  /** Cheap pass — storeys + ifcTypes. Always populated when the entry exists. */
  basic: FilterSchema;
  /** Expensive pass — pset/qto names. Lazily populated; null until requested. */
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
  /** Persistent SQL editor buffer — survives tab switching within the modal. */
  searchSqlQuery: string;
  /** Latest successful SQL result (or null on fresh tab open / error). */
  searchSqlResult: SearchSqlResult | null;
  /** Whether a SQL run is currently in flight. */
  searchSqlRunning: boolean;
  /** Latest SQL error message — raw DuckDB text, rewritten for UI by callers. */
  searchSqlError: string | null;
  /** Active sub-mode inside the SQL tab (Builder vs Editor). */
  searchSqlMode: SearchSqlMode;
  /** Unified filter state — chip rules, combinator, limit. */
  searchFilter: SearchFilterState;
  /** Per-model filter schema cache. Lazy. */
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

  setSearchSqlQuery: (query: string) => void;
  setSearchSqlRunning: (running: boolean) => void;
  setSearchSqlResult: (result: SearchSqlResult | null) => void;
  setSearchSqlError: (error: string | null) => void;

  setSearchSqlMode: (mode: SearchSqlMode) => void;

  // ── Filter-rule actions ───────────────────────────────────────────
  /** Replace the whole filter state — used by Reset and preset loading. */
  setSearchFilter: (state: SearchFilterState) => void;
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
  searchSqlQuery: '',
  searchSqlResult: null,
  searchSqlRunning: false,
  searchSqlError: null,
  searchSqlMode: 'builder',
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

  setSearchSqlQuery: (searchSqlQuery) => set({ searchSqlQuery }),
  setSearchSqlRunning: (searchSqlRunning) => set({ searchSqlRunning }),
  // Notebook-style result/error pairing: a successful run clears the
  // prior error (the new result supersedes it), but an error keeps the
  // prior result on screen — matches DuckDB UI / Jupyter behaviour where
  // each run displays independently and a failure doesn't invalidate
  // the previous good output. Callers that explicitly want to wipe both
  // can call `setSearchSqlResult(null)` then `setSearchSqlError(null)`.
  setSearchSqlResult: (searchSqlResult) => set({ searchSqlResult, searchSqlError: null }),
  setSearchSqlError: (searchSqlError) => set({ searchSqlError }),

  setSearchSqlMode: (searchSqlMode) => set({ searchSqlMode }),

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
