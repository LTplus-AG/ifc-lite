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
import { Search, Clock, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { Input } from '@/components/ui/input';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cn } from '@/lib/utils';
import { runTier0Scan, type SearchResult, type ScanModel } from '@/lib/search/tier0-scan';
import { queryTier1Indexes, type Tier1Index } from '@/lib/search/tier1-index';
import { useSearchIndex } from '@/hooks/useSearchIndex';
import {
  loadRecentSearches,
  pushRecentSearch,
  clearRecentSearches,
} from '@/lib/search/recent-searches';

const DEBOUNCE_MS = 80;
const RESULT_LIMIT = 50;

/** True when an editable surface has focus and should swallow `/` / `n` keystrokes. */
function isEditableFocused(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  // CodeMirror 6 editor — its content host wears `.cm-content`.
  if (el.closest?.('.cm-editor')) return true;
  return false;
}

export function SearchInline() {
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
    models,
    setSelectedEntity,
    setSelectedEntityId,
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
      models: s.models,
      setSelectedEntity: s.setSelectedEntity,
      setSelectedEntityId: s.setSelectedEntityId,
      toggleEntitySelection: s.toggleEntitySelection,
      cameraCallbacks: s.cameraCallbacks,
    })),
  );

  // Kick off lazy Tier-1 index builds for any loaded model.
  useSearchIndex();

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
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditableFocused()) {
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
      if (isEditableFocused()) return;
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

  /** Click-outside closes the popover (but doesn't blur the field). */
  useEffect(() => {
    if (!searchOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && containerRef.current && !containerRef.current.contains(target)) {
        setSearchOpen(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [searchOpen, setSearchOpen]);

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
        if (e.metaKey || e.ctrlKey) {
          setSearchOpen(false);
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
    [commitResult, results, searchHighlightIndex, searchOpen, setSearchHighlightIndex, setSearchModalOpen, setSearchOpen],
  );

  const queryTrimmedLen = searchQuery.trim().length;
  const showPopover = searchOpen && (results.length > 0 || queryTrimmedLen > 0 || recents.length > 0);
  const showRecents = searchOpen && queryTrimmedLen === 0 && recents.length > 0;

  return (
    <div ref={containerRef} className="relative w-72">
      <Input
        ref={inputRef}
        type="text"
        placeholder="Search GUID, name, type… ( / )"
        value={searchQuery}
        leftIcon={<Search className="h-4 w-4" />}
        onChange={(e) => {
          setSearchQuery(e.target.value);
          if (!searchOpen) setSearchOpen(true);
        }}
        onFocus={() => setSearchOpen(true)}
        onKeyDown={handleInputKeyDown}
        aria-label="Search entities"
        aria-autocomplete="list"
        aria-expanded={showPopover}
        aria-controls="search-inline-popover"
      />
      {/* Vim cycle hint — shows below the input whenever a cycle is active
          and the popover is closed. Clicking it exits the cycle. */}
      {searchVimCycle && !showPopover && (
        <VimCycleHint
          query={searchVimCycle.query}
          index={searchVimCycle.index}
          total={searchVimCycle.results.length}
          onExit={exitVimCycle}
        />
      )}
      {showPopover && showRecents && (
        <RecentsPopover
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
      )}
      {showPopover && !showRecents && (
        <SearchPopover
          results={results}
          highlightIndex={searchHighlightIndex}
          modelsCount={models.size}
          indexingCount={indexingCount}
          onSelect={(r, i, additive) => commitResult(r, i, additive)}
          onHover={(i) => setSearchHighlightIndex(i)}
          onOpenAdvanced={() => {
            setSearchOpen(false);
            setSearchModalOpen(true);
          }}
        />
      )}
    </div>
  );
}

interface VimCycleHintProps {
  query: string;
  index: number;
  total: number;
  onExit: () => void;
}

function VimCycleHint({ query, index, total, onExit }: VimCycleHintProps) {
  return (
    <div
      className="absolute left-0 right-0 top-full mt-1 flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-[11px] text-muted-foreground shadow-sm dark:border-zinc-800 dark:bg-zinc-950 z-40"
      role="status"
      aria-live="polite"
    >
      <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
        {index + 1} / {total}
      </span>
      <span className="truncate">
        <span className="opacity-70">cycling </span>
        <span className="font-mono">&quot;{query}&quot;</span>
        <span className="opacity-70"> — press </span>
        <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1 font-mono text-[10px] dark:border-zinc-700 dark:bg-zinc-900">n</kbd>
        <span className="opacity-70"> / </span>
        <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1 font-mono text-[10px] dark:border-zinc-700 dark:bg-zinc-900">N</kbd>
      </span>
      <button
        type="button"
        className="ml-auto rounded p-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        aria-label="Exit cycle"
        onMouseDown={(e) => {
          e.preventDefault();
          onExit();
        }}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

interface RecentsPopoverProps {
  recents: string[];
  onPick: (query: string) => void;
  onClear: () => void;
}

function RecentsPopover({ recents, onPick, onClear }: RecentsPopoverProps) {
  return (
    <div
      id="search-inline-popover"
      role="listbox"
      className="absolute left-0 right-0 top-full mt-1 rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950 z-50"
    >
      <div className="flex items-center justify-between px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          Recent searches
        </span>
        <button
          type="button"
          className="text-[10px] normal-case hover:underline"
          onMouseDown={(e) => {
            e.preventDefault();
            onClear();
          }}
        >
          Clear
        </button>
      </div>
      {recents.map((q) => (
        <button
          key={q}
          type="button"
          role="option"
          aria-selected={false}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(q);
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-50 dark:hover:bg-zinc-900"
        >
          <Search className="h-3 w-3 text-muted-foreground" />
          <span className="truncate font-mono">{q}</span>
        </button>
      ))}
    </div>
  );
}

interface SearchPopoverProps {
  results: SearchResult[];
  highlightIndex: number;
  modelsCount: number;
  indexingCount: number;
  onSelect: (r: SearchResult, index: number, additive: boolean) => void;
  onHover: (index: number) => void;
  onOpenAdvanced: () => void;
}

function SearchPopover({
  results,
  highlightIndex,
  modelsCount,
  indexingCount,
  onSelect,
  onHover,
  onOpenAdvanced,
}: SearchPopoverProps) {
  if (results.length === 0) {
    return (
      <div
        id="search-inline-popover"
        role="listbox"
        className="absolute left-0 right-0 top-full mt-1 rounded-md border border-zinc-200 bg-white px-3 py-4 text-xs text-muted-foreground shadow-lg dark:border-zinc-800 dark:bg-zinc-950 z-50"
      >
        {indexingCount > 0
          ? `Indexing ${indexingCount} model${indexingCount === 1 ? '' : 's'}… results appear as rows become searchable.`
          : 'No results — try a name, IFC type, or full GlobalId.'}
      </div>
    );
  }

  return (
    <div
      id="search-inline-popover"
      role="listbox"
      className="absolute left-0 right-0 top-full mt-1 max-h-96 overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950 z-50"
    >
      {results.map((r, i) => (
        <button
          key={`${r.modelId}:${r.expressId}`}
          type="button"
          role="option"
          aria-selected={i === highlightIndex}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            // mousedown so the input doesn't blur first and tear down the popover.
            e.preventDefault();
            onSelect(r, i, e.shiftKey);
          }}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors',
            i === highlightIndex
              ? 'bg-zinc-100 dark:bg-zinc-800'
              : 'hover:bg-zinc-50 dark:hover:bg-zinc-900',
          )}
        >
          <span className="shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-[10px] uppercase text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {r.typeName}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">
            {r.name || <span className="italic text-muted-foreground">unnamed</span>}
          </span>
          {r.globalId && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {r.globalId.slice(0, 8)}…
            </span>
          )}
          {modelsCount > 1 && (
            <span className="shrink-0 rounded border border-zinc-300 px-1 py-0.5 text-[10px] text-muted-foreground dark:border-zinc-700">
              {r.modelId.slice(0, 6)}
            </span>
          )}
        </button>
      ))}
      <div className="flex items-center gap-2 border-t border-zinc-200 px-3 py-1 text-[10px] text-muted-foreground dark:border-zinc-800">
        <span>
          {results.length} result{results.length === 1 ? '' : 's'} · ↑↓ · ↵ · ⇧↵ · Esc
          {indexingCount > 0 && <span className="ml-2 opacity-80">· indexing {indexingCount}…</span>}
        </span>
        <button
          type="button"
          className="ml-auto hover:underline"
          onMouseDown={(e) => {
            e.preventDefault();
            onOpenAdvanced();
          }}
        >
          Advanced <kbd className="ml-0.5 rounded border border-zinc-300 bg-zinc-100 px-1 font-mono text-[9px] dark:border-zinc-700 dark:bg-zinc-900">⌘↵</kbd>
        </button>
      </div>
    </div>
  );
}
