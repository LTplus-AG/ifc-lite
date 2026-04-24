/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SearchModal — advanced search (⌘⇧F / Ctrl+Shift+F).
 *
 * Shares `searchSlice.searchQuery` with the inline field, so the modal
 * can never "lose" what you've already typed — open it and the query is
 * already there, adjust it and closing the modal leaves the inline in
 * sync. The tab switcher has a "Search" tab (P3) and a "SQL" tab stub
 * reserved for P4. All search engines (Tier-0 linear scan, Tier-1 token
 * index) are reused — the modal just renders a bigger, unfiltered,
 * virtualized version of what the inline popover shows.
 *
 * Keyboard (inside the modal):
 *   • ↑ / ↓        — navigate result rows
 *   • Enter        — commit (select + frame + enter vim cycle + close)
 *   • ⇧Enter       — toggle row in multi-selection (stays open)
 *   • Esc          — close modal
 *   • ⌘⇧F / Ctrl+⇧F — toggle modal closed (symmetric with open)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useViewerStore } from '@/store';
import { runTier0Scan, type SearchResult, type ScanModel } from '@/lib/search/tier0-scan';
import { queryTier1Indexes, type Tier1Index } from '@/lib/search/tier1-index';
import { useSearchIndex } from '@/hooks/useSearchIndex';
import { pushRecentSearch } from '@/lib/search/recent-searches';
import { SearchModalText } from './SearchModal.text';

/** Modal-side result cap. Well above what any user scrolls through, small
 *  enough that the score/merge arrays stay cheap. Virtualization keeps
 *  DOM cost constant regardless. */
const RESULT_LIMIT_MODAL = 5000;
const DEBOUNCE_MS = 80;

export function SearchModal() {
  const {
    searchQuery,
    searchModalOpen,
    searchIndexes,
    models,
    setSearchModalOpen,
    toggleSearchModal,
    setSearchQuery,
  } = useViewerStore(
    useShallow((s) => ({
      searchQuery: s.searchQuery,
      searchModalOpen: s.searchModalOpen,
      searchIndexes: s.searchIndexes,
      models: s.models,
      setSearchModalOpen: s.setSearchModalOpen,
      toggleSearchModal: s.toggleSearchModal,
      setSearchQuery: s.setSearchQuery,
    })),
  );

  // Make sure Tier-1 indexes continue building while the modal is open
  // (the inline also mounts this hook — cheap re-registration).
  useSearchIndex();

  // Debounce the query the same way the inline does, so fast typing
  // inside the modal doesn't re-scan per keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState(searchQuery);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(searchQuery), DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchQuery]);

  // Split models into the two search tiers. Same logic as SearchInline.
  const { tier0Models, tier1Indexes, availableModelIds } = useMemo(() => {
    const t0: ScanModel[] = [];
    const t1: Tier1Index[] = [];
    const ids: string[] = [];
    for (const m of models.values()) {
      if (!m.ifcDataStore) continue;
      ids.push(m.id);
      const record = searchIndexes.get(m.id);
      if (record?.status === 'ready' && record.index) {
        t1.push(record.index);
      } else {
        t0.push({ id: m.id, ifcDataStore: m.ifcDataStore });
      }
    }
    return { tier0Models: t0, tier1Indexes: t1, availableModelIds: ids };
  }, [models, searchIndexes]);

  // Full result pool (pre-filter). Filtering happens inside the tab.
  const results = useMemo<SearchResult[]>(() => {
    if (!debouncedQuery.trim()) return [];
    if (tier0Models.length === 0 && tier1Indexes.length === 0) return [];

    const t1Results = tier1Indexes.length > 0
      ? queryTier1Indexes(tier1Indexes, debouncedQuery, { limit: RESULT_LIMIT_MODAL })
      : [];
    const t0Results = tier0Models.length > 0
      ? runTier0Scan(tier0Models, debouncedQuery, { limit: RESULT_LIMIT_MODAL })
      : [];

    if (t1Results.length === 0) return t0Results;
    if (t0Results.length === 0) return t1Results;

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
      if (out.length >= RESULT_LIMIT_MODAL) break;
    }
    return out;
  }, [tier0Models, tier1Indexes, debouncedQuery]);

  /** Global ⌘⇧F / Ctrl+⇧F toggle — opens from anywhere, also closes when open. */
  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const isAdvancedShortcut =
        (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'f' || e.key === 'F');
      if (isAdvancedShortcut) {
        e.preventDefault();
        toggleSearchModal();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleSearchModal]);

  /** Record the query in recents the first time the modal actually has a
   *  non-empty query at the moment it closes — mirrors what the inline
   *  does on Enter-commit without requiring the user to commit a row. */
  const hadNonEmptyOnOpenRef = useRef(false);
  useEffect(() => {
    if (searchModalOpen) {
      hadNonEmptyOnOpenRef.current = searchQuery.trim().length > 0;
      return;
    }
    // Modal just closed — if a query was typed during the session, record it.
    if (hadNonEmptyOnOpenRef.current || searchQuery.trim().length > 0) {
      const q = searchQuery.trim();
      if (q) pushRecentSearch(q);
    }
  }, [searchModalOpen, searchQuery]);

  // Auto-select the input on open so typing is immediate.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchModalOpen) {
      // Next tick so Radix Dialog has mounted the content.
      const t = window.setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      }, 10);
      return () => window.clearTimeout(t);
    }
  }, [searchModalOpen]);

  const close = useCallback(() => setSearchModalOpen(false), [setSearchModalOpen]);

  if (!searchModalOpen) return null;

  return (
    <Dialog open={searchModalOpen} onOpenChange={(open) => setSearchModalOpen(open)}>
      <DialogContent
        hideCloseButton
        className="max-w-4xl h-[80vh] p-0 gap-0 flex flex-col"
        onEscapeKeyDown={close}
      >
        <DialogTitle className="sr-only">Advanced Search</DialogTitle>
        <Tabs defaultValue="search" className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <TabsList>
              <TabsTrigger value="search">
                <Search className="h-3.5 w-3.5 mr-1.5" />
                Search
              </TabsTrigger>
              <TabsTrigger value="sql" disabled>
                SQL
                <span className="ml-1.5 rounded bg-zinc-200 px-1 py-0.5 text-[10px] font-normal text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                  soon
                </span>
              </TabsTrigger>
            </TabsList>
            <div className="text-[11px] text-muted-foreground">
              <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1 font-mono text-[10px] dark:border-zinc-700 dark:bg-zinc-900">Esc</kbd>
              <span className="ml-1">close</span>
            </div>
          </div>
          <TabsContent value="search" className="flex-1 min-h-0 mt-0 flex flex-col">
            <div className="border-b px-4 py-3">
              <Input
                ref={inputRef}
                type="text"
                placeholder="Search GUID, name, type, description, objectType…"
                value={searchQuery}
                leftIcon={<Search className="h-4 w-4" />}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-10 text-sm"
                aria-label="Advanced search query"
              />
            </div>
            <SearchModalText
              results={results}
              availableModelIds={availableModelIds}
              onClose={close}
            />
          </TabsContent>
          <TabsContent value="sql" className="flex-1 mt-0 p-6 text-sm text-muted-foreground">
            <div className="text-center">
              <p>SQL search arrives in the next phase.</p>
              <p className="mt-1 text-xs">
                Backed by the existing DuckDB integration — full property value queries,
                joins across entities / properties / quantities, CSV / JSON export.
              </p>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
