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

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, SlidersHorizontal } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useViewerStore } from '@/store';
import { useTranslation } from '@/i18n';
import { registerKeyboardCommand } from '@/lib/commands/dispatcher';
import type { SearchResult } from '@/lib/search/tier0-scan';
import { collectSearchResults } from '@/lib/search/collect-results';
import { pushRecentSearch } from '@/lib/search/recent-searches';
import { SearchModalText } from './SearchModal.text';
import { SearchModalFilter } from './SearchModal.filter';
const NativeLibrarySearch = lazy(() => import('./libraries/NativeLibrarySearch').then(module => ({ default: module.NativeLibrarySearch })));

const DEBOUNCE_MS = 80;

export function SearchModal() {
  const { t } = useTranslation();
  const {
    searchQuery,
    searchModalOpen,
    searchModalTab,
    searchIndexes,
    models,
    setSearchModalOpen,
    setSearchModalTab,
    setSearchQuery,
  } = useViewerStore(
    useShallow((s) => ({
      searchQuery: s.searchQuery,
      searchModalOpen: s.searchModalOpen,
      searchModalTab: s.searchModalTab,
      searchIndexes: s.searchIndexes,
      models: s.models,
      setSearchModalOpen: s.setSearchModalOpen,
      setSearchModalTab: s.setSearchModalTab,
      setSearchQuery: s.setSearchQuery,
    })),
  );

  // Debounce the query the same way the inline does, so fast typing
  // inside the modal doesn't re-scan per keystroke.
  const [debouncedQuery, setDebouncedQuery] = useState(searchQuery);
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQuery(searchQuery), DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchQuery]);

  const availableModelIds = useMemo(() =>
    [...models.values()].filter((model) => model.ifcDataStore).map((model) => model.id), [models]);

  // Full result pool (pre-filter). Filtering happens inside the tab.
  const results = useMemo<SearchResult[]>(() =>
    collectSearchResults(models, searchIndexes, debouncedQuery), [models, searchIndexes, debouncedQuery]);

  /** Global ⌘⇧F / Ctrl+⇧F toggle — opens from anywhere, also closes when open.
   *  This is a text-search entry point, so opening always lands on the Search
   *  tab (the controlled tab otherwise remembers the last-used Filter tab). */
  useLayoutEffect(() => {
    const toggle = () => {
      if (searchModalOpen) setSearchModalOpen(false);
      else { setSearchModalTab('search'); setSearchModalOpen(true); }
    };
    const removeGlobal = registerKeyboardCommand('search.openAdvanced', toggle, { allowInTextEntry: true });
    const removeModal = searchModalOpen
      ? registerKeyboardCommand('search.openAdvanced', toggle, { layer: 'modal', allowInTextEntry: true })
      : () => {};
    return () => { removeGlobal(); removeModal(); };
  }, [searchModalOpen, setSearchModalOpen, setSearchModalTab]);

  /**
   * Record the query in recents on the modal-close *transition* — once
   * per close, with the final query at that moment. We watch only
   * `searchModalOpen` (not `searchQuery`) so typing in the inline bar
   * while the modal is closed never fires this effect; without that
   * gate, every keystroke in the inline bar (which shares `searchQuery`
   * with the modal) would push a partial-prefix recent.
   *
   * `prevOpenRef` distinguishes the "opened then closed" transition
   * from the initial mount where `searchModalOpen` is already false.
   */
  const prevOpenRef = useRef(searchModalOpen);
  useEffect(() => {
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = searchModalOpen;
    if (wasOpen && !searchModalOpen) {
      // Use the latest searchQuery via a fresh read — depending on it
      // would re-fire this effect on every keystroke. Since the close
      // transition is what we care about, the latest value at close
      // time is the right thing to record.
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
        <DialogTitle className="sr-only">{t('searchModal.shell.title')}</DialogTitle>
        <Tabs
          value={searchModalTab}
          onValueChange={(v) => setSearchModalTab(v as typeof searchModalTab)}
          className="flex flex-col flex-1 min-h-0"
        >
          <div className="flex items-center justify-between border-b px-4 py-3">
            <TabsList>
              <TabsTrigger value="search">
                <Search className="h-3.5 w-3.5 mr-1.5" />
                {t('searchModal.shell.searchTab')}
              </TabsTrigger>
              <TabsTrigger value="filter">
                <SlidersHorizontal className="h-3.5 w-3.5 mr-1.5" />
                {t('searchModal.shell.filterTab')}
              </TabsTrigger>
              <TabsTrigger value="libraries">{t('searchModal.library.title')}</TabsTrigger>
            </TabsList>
            <div className="text-2xs text-muted-foreground">
              <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1 font-mono text-2xs dark:border-zinc-700 dark:bg-zinc-900">{t('searchModal.shell.escKey')}</kbd>
              <span className="ml-1">{t('searchModal.shell.closeHint')}</span>
            </div>
          </div>
          <TabsContent value="search" className="flex-1 min-h-0 mt-0 flex flex-col">
            <div className="border-b px-4 py-3">
              <Input
                ref={inputRef}
                type="text"
                placeholder={t('searchModal.shell.searchPlaceholder')}
                value={searchQuery}
                leftIcon={<Search className="h-4 w-4" />}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-10 text-sm"
                aria-label={t('searchModal.shell.searchAriaLabel')}
              />
            </div>
            <SearchModalText
              results={results}
              availableModelIds={availableModelIds}
              onClose={close}
            />
          </TabsContent>
          <TabsContent value="filter" className="flex-1 min-h-0 mt-0 flex">
            <SearchModalFilter />
          </TabsContent>
          <TabsContent value="libraries" className="flex-1 min-h-0 mt-0 flex">
            <Suspense fallback={<p role="status">{t('searchModal.library.phase.loading', { count: 0 })}</p>}>
              <NativeLibrarySearch onOpened={close} />
            </Suspense>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
