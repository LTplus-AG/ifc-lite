/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SearchInline — always-visible search field in the MainToolbar.
 *
 * P0: Tier-0 linear scan over cached EntityTable columns.
 * P1: Tier-1 per-model inverted token index, built post-load.
 * P2: Vim-style n/N cycle after Enter-commit, plus recent-search MRU
 *     surfaced in the popover when the field is focused with empty query.
 *
 * Keyboard:
 *   • `/` or ⌘F / Ctrl+F  → focus the field (focus-suppressed when an
 *     input/textarea/CodeMirror editor already has focus)
 *   • ↑ / ↓               → navigate result rows in the popover
 *   • Enter               → select + frame the highlighted result,
 *                           enter vim cycle mode, record recent
 *   • ⇧Enter              → add to multi-selection (no frame, no cycle)
 *   • Esc                 → close popover; second Esc blurs the field;
 *                           while cycling, Esc exits the cycle
 *   • n / N               → step forward / backward through the cycle,
 *                           framing each match (fires anywhere except
 *                           inside other editable surfaces)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, SlidersHorizontal } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cn } from '@/lib/utils';
import { isTextEntryTarget } from '@/lib/keyboard-event';
import { useTranslation } from '@/i18n';
import { runTier0Scan, type SearchResult, type ScanModel } from '@/lib/search/tier0-scan';
import { queryTier1Indexes, type Tier1Index } from '@/lib/search/tier1-index';
import {
  loadRecentSearches,
  pushRecentSearch,
  clearRecentSearches,
} from '@/lib/search/recent-searches';
import { VimCycleHint, RecentsPopoverBody, SearchPopoverBody } from './SearchInlinePopoverBody';

const DEBOUNCE_MS = 80;
const RESULT_LIMIT = 50;

/** True when the key lands on a surface that should swallow `/` / `n` keystrokes. */
function isEditableFocused(e: globalThis.KeyboardEvent): boolean {
  if (isTextEntryTarget(e)) return true;
  // CodeMirror 6 editor — its content host wears `.cm-content`.
  return e.target instanceof Element && e.target.closest('.cm-editor') !== null;
}

export function SearchInline() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Tracks the latest scheduled `frameSelection` timer so back-to-back
  // selection changes (or unmount) don't leak orphaned timeouts. Without
  // this, picking a different result inside the 50ms window — or
  // unmounting the component — leaves a stale callback queued that fires
  // on a now-unrelated camera state.
  const frameTimerRef = useRef<number | null>(null);

  const {
    searchQuery,
    searchOpen,
    searchHighlightIndex,
    searchIndexes,
    searchVimCycle,
    setSearchQuery,
    setSearchOpen,
    setSearchHighlightIndex,
    closeSearch,
    enterVimCycle,
    exitVimCycle,
    stepVimCycle,
    setSearchModalOpen,
    setSearchModalTab,
    activeRuleCount,
    clearAllFilterGroups,
    models,
    setSelectedEntity,
    setSelectedEntityId,
    setSelectedEntityIds,
    toggleEntitySelection,
    cameraCallbacks,
  } = useViewerStore(
    useShallow((s) => ({
      searchQuery: s.searchQuery,
      searchOpen: s.searchOpen,
      searchHighlightIndex: s.searchHighlightIndex,
      searchIndexes: s.searchIndexes,
      searchVimCycle: s.searchVimCycle,
      setSearchQuery: s.setSearchQuery,
      setSearchOpen: s.setSearchOpen,
      setSearchHighlightIndex: s.setSearchHighlightIndex,
      closeSearch: s.closeSearch,
      enterVimCycle: s.enterVimCycle,
      exitVimCycle: s.exitVimCycle,
      stepVimCycle: s.stepVimCycle,
      setSearchModalOpen: s.setSearchModalOpen,
      setSearchModalTab: s.setSearchModalTab,
      activeRuleCount: s.searchFilter.groups.reduce((n, g) => n + g.rules.length, 0),
      clearAllFilterGroups: s.clearAllFilterGroups,
      models: s.models,
      setSelectedEntity: s.setSelectedEntity,
      setSelectedEntityId: s.setSelectedEntityId,
      setSelectedEntityIds: s.setSelectedEntityIds,
      toggleEntitySelection: s.toggleEntitySelection,
      cameraCallbacks: s.cameraCallbacks,
    })),
  );

  // Recents list — loaded on mount, refreshed after each Enter commit.
  const [recents, setRecents] = useState<string[]>(() => loadRecentSearches());

  // Debounce the query so each keystroke doesn't trigger a 4M-entity scan.
  const [debouncedQuery, setDebouncedQuery] = useState(searchQuery);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(searchQuery), DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchQuery]);

  // Clear any pending frame timer on unmount so a fire-and-forget
  // callback can't outlive the component.
  useEffect(() => () => {
    if (frameTimerRef.current !== null) {
      window.clearTimeout(frameTimerRef.current);
      frameTimerRef.current = null;
    }
  }, []);

  // Split models into two pools: those with a ready Tier-1 index, and
  // those still relying on the Tier-0 linear scan. Recomputed only when
  // either the federation or the index map changes identity.
  const { tier0Models, tier1Indexes, indexingCount } = useMemo(() => {
    const t0: ScanModel[] = [];
    const t1: Tier1Index[] = [];
    let building = 0;
    for (const m of models.values()) {
      if (!m.ifcDataStore) continue;
      const record = searchIndexes.get(m.id);
      if (record?.status === 'ready' && record.index) {
        t1.push(record.index);
      } else {
        t0.push({ id: m.id, ifcDataStore: m.ifcDataStore });
        if (record?.status === 'building') building += 1;
      }
    }
    return { tier0Models: t0, tier1Indexes: t1, indexingCount: building };
  }, [models, searchIndexes]);

  /**
   * Run the Tier-0/Tier-1 scan synchronously for an arbitrary query.
   * Extracted from the debounced `results` memo so the Enter-commit
   * path can flush against the LIVE `searchQuery` rather than the
   * debounced snapshot — without it, hitting Enter inside the 80ms
   * debounce window commits a hit from the previous query and records
   * the wrong recent-search term, even though the input shows newer
   * text (Codex P2: "Commit inline search against the current query").
   */
  const runScan = useCallback((q: string): SearchResult[] => {
    if (!q.trim()) return [];
    if (tier0Models.length === 0 && tier1Indexes.length === 0) return [];

    const t1Results =
      tier1Indexes.length > 0
        ? queryTier1Indexes(tier1Indexes, q, { limit: RESULT_LIMIT })
        : [];
    const t0Results =
      tier0Models.length > 0
        ? runTier0Scan(tier0Models, q, { limit: RESULT_LIMIT })
        : [];

    if (t1Results.length === 0) return t0Results;
    if (t0Results.length === 0) return t1Results;

    // Merge + dedupe. Scores from Tier-0 and Tier-1 share the same ladder
    // so a descending-score sort is stable between them.
    const combined = [...t1Results, ...t0Results];
    combined.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.modelId !== b.modelId) return a.modelId < b.modelId ? -1 : 1;
      return a.expressId - b.expressId;
    });
    const seen = new Set<string>();
    const out: SearchResult[] = [];
    for (const r of combined) {
      const key = `${r.modelId}:${r.expressId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= RESULT_LIMIT) break;
    }
    return out;
  }, [tier0Models, tier1Indexes]);

  const results = useMemo<SearchResult[]>(
    () => runScan(debouncedQuery),
    [runScan, debouncedQuery],
  );

  // Keep the highlight index in range as results change.
  useEffect(() => {
    if (results.length === 0) {
      if (searchHighlightIndex !== 0) setSearchHighlightIndex(0);
      return;
    }
    if (searchHighlightIndex >= results.length) {
      setSearchHighlightIndex(Math.max(0, results.length - 1));
    }
  }, [results, searchHighlightIndex, setSearchHighlightIndex]);

  /** Apply selection + frame for a search result. Does NOT touch cycle state. */
  const applySelection = useCallback(
    (r: SearchResult, addToSelection: boolean) => {
      const ref = { modelId: r.modelId, expressId: r.expressId };
      const isLegacy = r.modelId === 'legacy' || r.modelId === '__legacy__' || models.size === 0;
      const globalId = isLegacy ? r.expressId : toGlobalIdFromModels(models, r.modelId, r.expressId);

      if (addToSelection) {
        // Shift+Enter additive — TOGGLES rather than just adds, so a
        // second Shift+Enter on the same row deselects (was: forced
        // the user to clear the entire multi-selection to undo).
        toggleEntitySelection(ref);
        setSelectedEntityId(globalId);
        return;
      }

      // Clear multi-selection first (setSelectedEntityIds([]) resets selectedEntityId)
      setSelectedEntityIds([]);
      setSelectedEntityId(globalId);
      setSelectedEntity(ref);
      if (cameraCallbacks.frameSelection) {
        if (frameTimerRef.current !== null) window.clearTimeout(frameTimerRef.current);
        frameTimerRef.current = window.setTimeout(() => {
          cameraCallbacks.frameSelection?.();
          frameTimerRef.current = null;
        }, 50);
      }
    },
    [
      cameraCallbacks,
      models,
      setSelectedEntity,
      setSelectedEntityId,
      setSelectedEntityIds,
      toggleEntitySelection,
    ],
  );

  /**
   * Commit: select + frame + enter vim cycle + record recent.
   *
   * `overrideResults` / `overrideQuery` let the Enter-commit path
   * pass freshly-scanned results from the LIVE `searchQuery` when
   * the debounce hasn't settled yet — without that, the user's
   * `n`/`N` cycle and the recorded recent both reflect the prior
   * (debounced) query rather than what the input shows.
   */
  const commitResult = useCallback(
    (
      r: SearchResult,
      index: number,
      addToSelection: boolean,
      overrideResults?: SearchResult[],
      overrideQuery?: string,
    ) => {
      const cycleResults = overrideResults ?? results;
      const cycleQuery = overrideQuery ?? debouncedQuery;
      applySelection(r, addToSelection);
      if (!addToSelection && cycleResults.length > 0) {
        enterVimCycle(cycleQuery, cycleResults, index);
      }
      const trimmed = cycleQuery.trim();
      if (trimmed) setRecents(pushRecentSearch(trimmed));
      closeSearch();
    },
    [applySelection, closeSearch, debouncedQuery, enterVimCycle, results],
  );

  // Re-select + reframe when the vim cycle steps. Uses the results-array
  // identity to distinguish entry (selection already done by commitResult)
  // from subsequent steps (this effect drives the selection).
  const handledCycleRef = useRef<{ results: SearchResult[]; index: number } | null>(null);
  useEffect(() => {
    if (!searchVimCycle) {
      handledCycleRef.current = null;
      return;
    }
    const last = handledCycleRef.current;
    const isEntry = !last || last.results !== searchVimCycle.results;
    handledCycleRef.current = {
      results: searchVimCycle.results,
      index: searchVimCycle.index,
    };
    if (isEntry) return; // selection was performed by commitResult.
    const current = searchVimCycle.results[searchVimCycle.index];
    if (current) applySelection(current, false);
  }, [searchVimCycle, applySelection]);

  /** Global `/` and ⌘F / Ctrl+F shortcuts to focus the field. */
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      // ⌘F / Ctrl+F focuses regardless of what else has focus — we want
      // to override the browser's native Find inside the viewer.
      const isFindShortcut = (e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && !e.shiftKey;
      if (isFindShortcut) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setSearchOpen(true);
        return;
      }

      // `/` only when no other input is focused — vim-style search summon.
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditableFocused(e)) {
        e.preventDefault();
        inputRef.current?.focus();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [setSearchOpen]);

  /** Global n / N / Esc cycle-control listener — active only while cycling. */
  useEffect(() => {
    if (!searchVimCycle) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Don't swallow `n` / `N` when the user is typing elsewhere.
      if (isEditableFocused(e)) return;
      if (e.key === 'n') {
        e.preventDefault();
        stepVimCycle(1);
        return;
      }
      if (e.key === 'N') {
        e.preventDefault();
        stepVimCycle(-1);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        exitVimCycle();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [searchVimCycle, stepVimCycle, exitVimCycle]);

  const handleInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Esc: first press closes popover, second blurs the field. Cycle
      // exit is handled by the global listener, so we don't fight it here.
      if (e.key === 'Escape') {
        if (searchOpen) {
          e.preventDefault();
          setSearchOpen(false);
        } else {
          inputRef.current?.blur();
        }
        return;
      }

      if (!searchOpen && (e.key === 'ArrowDown' || e.key === 'Enter')) {
        if (results.length > 0) setSearchOpen(true);
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (results.length === 0) return;
        const next = (searchHighlightIndex + 1) % results.length;
        setSearchHighlightIndex(next);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (results.length === 0) return;
        const next = (searchHighlightIndex - 1 + results.length) % results.length;
        setSearchHighlightIndex(next);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        // ⌘↵ / Ctrl+↵ opens the advanced modal instead of committing — the
        // inline query is preserved so the modal opens already populated.
        // Text-search entry point, so land on the Search tab.
        if (e.metaKey || e.ctrlKey) {
          setSearchOpen(false);
          setSearchModalTab('search');
          setSearchModalOpen(true);
          return;
        }
        // Flush the debounce: if the user typed something that hasn't yet
        // settled into `debouncedQuery`, re-scan synchronously against the
        // LIVE `searchQuery`. The popover is showing stale results in that
        // window (debounced still reflects the prior query) so committing
        // `results[index]` would select the wrong entity. Match the input.
        const live = searchQuery;
        const useLive = live.trim() !== debouncedQuery.trim();
        const liveResults = useLive ? runScan(live) : results;
        if (liveResults.length === 0) return;
        const idx = useLive
          ? Math.min(searchHighlightIndex, liveResults.length - 1)
          : searchHighlightIndex;
        const target = liveResults[idx];
        if (target) commitResult(target, idx, e.shiftKey, liveResults, live);
      }
    },
    [commitResult, results, searchHighlightIndex, searchOpen, setSearchHighlightIndex, setSearchModalOpen, setSearchModalTab, setSearchOpen],
  );

  const hasFilters = activeRuleCount > 0;

  /** Open the advanced modal straight to the Filter builder — the
   *  always-visible entry point to structured filtering. */
  const openAdvancedFilter = useCallback(() => {
    setSearchOpen(false);
    setSearchModalTab('filter');
    setSearchModalOpen(true);
  }, [setSearchOpen, setSearchModalTab, setSearchModalOpen]);

  const queryTrimmedLen = searchQuery.trim().length;
  const showPopover = searchOpen && (results.length > 0 || queryTrimmedLen > 0 || recents.length > 0);
  const showRecents = searchOpen && queryTrimmedLen === 0 && recents.length > 0;

  return (
    <Popover
      open={showPopover}
      onOpenChange={(next) => {
        // Radix's own Esc/outside-click dismissal lands here; opening is
        // still driven by the input's own `onFocus`/`onChange` above (via
        // `showPopover`'s derived conditions), not by this callback.
        if (!next) setSearchOpen(false);
      }}
    >
      <PopoverAnchor asChild>
        <div ref={containerRef} className="relative w-72">
          <Input
            ref={inputRef}
            type="text"
            placeholder={t('searchModal.inline.searchPlaceholder')}
            value={searchQuery}
            leftIcon={<Search className="h-4 w-4" />}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (!searchOpen) setSearchOpen(true);
            }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={handleInputKeyDown}
            className={cn(hasFilters ? 'pr-[4.5rem]' : 'pr-9')}
            aria-label={t('searchModal.inline.searchAriaLabel')}
            aria-autocomplete="list"
            aria-expanded={showPopover}
            aria-controls="search-inline-popover"
          />
          {/* Advanced-filter affordance — always visible so structured
              filtering is discoverable without the ⌘⇧F shortcut. Shows the
              active rule count and a quick-clear when a filter is applied. */}
          <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
            {hasFilters && (
              <button
                type="button"
                aria-label={t('searchModal.inline.clearFiltersAriaLabel')}
                title={t('searchModal.inline.clearFiltersAriaLabel')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  clearAllFilterGroups();
                }}
                className="rounded p-1 text-muted-foreground transition-colors hover:bg-zinc-100 hover:text-foreground dark:hover:bg-zinc-800"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="button"
              aria-label={hasFilters ? t('searchModal.inline.advancedFilterActiveAriaLabel', { count: activeRuleCount }) : t('searchModal.inline.advancedFilter')}
              aria-pressed={hasFilters}
              title={t('searchModal.inline.advancedFilterTitle')}
              onMouseDown={(e) => {
                e.preventDefault();
                openAdvancedFilter();
              }}
              className={cn(
                // Height-only hit-slop to 24px (#5826); `inset-x-0` avoids the 2px neighbour gap.
                'relative flex items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors after:absolute after:inset-x-0 after:-top-px after:-bottom-px after:content-[""] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                hasFilters
                  ? 'bg-primary/10 text-primary hover:bg-primary/15'
                  : 'text-muted-foreground hover:bg-zinc-100 hover:text-foreground dark:hover:bg-zinc-800',
              )}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {hasFilters && (
                <span className="font-mono text-[10px] font-semibold leading-none">{activeRuleCount}</span>
              )}
            </button>
          </div>
          {/* Vim cycle hint — shows below the input whenever a cycle is active
              and the popover is closed. Clicking it exits the cycle. */}
          {searchVimCycle && !showPopover && (
            <VimCycleHint query={searchVimCycle.query} index={searchVimCycle.index} total={searchVimCycle.results.length} onExit={exitVimCycle} />
          )}
        </div>
      </PopoverAnchor>
      {/* This is a combobox listbox, not a dialog: focus stays on the
          input the whole time (arrow keys / Enter are handled by
          `handleInputKeyDown` above), so autofocus into — and back out
          of — the content is suppressed on both ends. Radix still owns
          Esc and outside-click dismissal (`onOpenChange` above) and the
          `PointerEvent`s a `mousedown`-based row pick needs pass through
          unchanged, since neither listener intercepts them.
          `onFocusOutside` is suppressed for the Anchor: the input is a
          SIBLING of Content, not a descendant of it, so — without this —
          Radix's `DismissableLayer` reads every keystroke's focus staying
          on the input as focus moving OUTSIDE the popover and closes it
          on the very next render; a combobox needs focus to stay on its
          input while the list is open, so that "outside" reading is wrong
          here specifically. `onPointerDownOutside` needs the SAME
          exemption for the same reason: a `mousedown` in the input (moving
          the caret) or on the clear-filters/advanced-filter buttons (both
          siblings of Content inside the Anchor) is, by the same
          sibling-not-descendant logic, read as "outside" and would close
          the popover. Real outside clicks still close it via `onOpenChange`. */}
      <PopoverContent
        id="search-inline-popover"
        role="listbox"
        align="start"
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onFocusOutside={(e) => {
          const target = e.detail.originalEvent.target as Node | null;
          if (target && containerRef.current?.contains(target)) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          const target = e.detail.originalEvent.target as Node | null;
          if (target && containerRef.current?.contains(target)) e.preventDefault();
        }}
        style={{ width: 'var(--radix-popper-anchor-width)' }}
        className="w-72 rounded-md border border-zinc-200 bg-white p-0 shadow-lg dark:border-zinc-800 dark:bg-zinc-950"
      >
        {showRecents ? (
          <RecentsPopoverBody
            recents={recents}
            onPick={(q) => {
              setSearchQuery(q);
              inputRef.current?.focus();
            }}
            onClear={() => {
              clearRecentSearches();
              setRecents([]);
            }}
          />
        ) : (
          <SearchPopoverBody
            results={results}
            query={searchQuery}
            highlightIndex={searchHighlightIndex}
            modelsCount={models.size}
            indexingCount={indexingCount}
            onSelect={(r, i, additive) => commitResult(r, i, additive)}
            onHover={(i) => setSearchHighlightIndex(i)}
            onOpenAdvanced={() => {
              setSearchOpen(false);
              setSearchModalTab('search');
              setSearchModalOpen(true);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
