/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * SearchModal.text — the Search tab content.
 *
 * Chip filters (field match type + per-model include) narrow the pool
 * of results provided by the parent modal, which owns the scan + merge.
 * The result list is virtualized via @tanstack/react-virtual so 5000
 * rows render at constant cost. Batch actions route through the
 * existing selection / visibility slices.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Crosshair, SquareX, ListChecks, Filter } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useViewerStore } from '@/store';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useTranslation } from '@/i18n';
import type { SearchResult } from '@/lib/search/tier0-scan';
import { FIELD_FILTERS, ROW_HEIGHT, resultOptionId, type SearchModalTextProps } from './SearchModal.text.model';
export type { SearchModalTextProps } from './SearchModal.text.model';

export function SearchModalText({ results, availableModelIds, onClose }: SearchModalTextProps) {
  const { t } = useTranslation();
  const {
    searchFieldFilter,
    searchModelFilter,
    searchQuery,
    searchHighlightIndex,
    selectedEntitiesSet,
    models,
    setSearchFieldFilter,
    toggleSearchModelFilter,
    clearSearchModelFilter,
    setSearchHighlightIndex,
    setSelectedEntity,
    setSelectedEntityId,
    setSelectedEntityIds,
    addEntitiesToSelection,
    toggleEntitySelection,
    clearEntitySelection,
    enterVimCycle,
    cameraCallbacks,
  } = useViewerStore(
    useShallow((s) => ({
      searchFieldFilter: s.searchFieldFilter,
      searchModelFilter: s.searchModelFilter,
      searchQuery: s.searchQuery,
      searchHighlightIndex: s.searchHighlightIndex,
      selectedEntitiesSet: s.selectedEntitiesSet,
      models: s.models,
      setSearchFieldFilter: s.setSearchFieldFilter,
      toggleSearchModelFilter: s.toggleSearchModelFilter,
      clearSearchModelFilter: s.clearSearchModelFilter,
      setSearchHighlightIndex: s.setSearchHighlightIndex,
      setSelectedEntity: s.setSelectedEntity,
      setSelectedEntityId: s.setSelectedEntityId,
      setSelectedEntityIds: s.setSelectedEntityIds,
      addEntitiesToSelection: s.addEntitiesToSelection,
      toggleEntitySelection: s.toggleEntitySelection,
      clearEntitySelection: s.clearEntitySelection,
      enterVimCycle: s.enterVimCycle,
      cameraCallbacks: s.cameraCallbacks,
    })),
  );

  // Filter the result pool by the active chip selections.
  const filtered = useMemo(() => {
    return results.filter((r) => {
      if (searchFieldFilter !== 'all' && r.matchField !== searchFieldFilter) return false;
      if (searchModelFilter && !searchModelFilter.has(r.modelId)) return false;
      return true;
    });
  }, [results, searchFieldFilter, searchModelFilter]);

  // Virtualized list setup. `count` tracks filtered.length; scrollElement
  // is the parent div the virtualizer measures.
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // Keep the highlight index in range as filtered results change.
  useEffect(() => {
    if (filtered.length === 0) {
      if (searchHighlightIndex !== 0) setSearchHighlightIndex(0);
      return;
    }
    if (searchHighlightIndex >= filtered.length) {
      setSearchHighlightIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered, searchHighlightIndex, setSearchHighlightIndex]);

  // Scroll the highlighted row into view when it moves.
  useEffect(() => {
    if (filtered.length === 0) return;
    virtualizer.scrollToIndex(searchHighlightIndex, { align: 'auto' });
  }, [searchHighlightIndex, filtered.length, virtualizer]);

  /** Primary "click row" handler — selects + frames + enters vim cycle. */
  const commit = useCallback(
    (r: SearchResult, indexInFiltered: number) => {
      const ref = { modelId: r.modelId, expressId: r.expressId };
      const isLegacy = r.modelId === 'legacy' || r.modelId === '__legacy__' || models.size === 0;
      const globalId = isLegacy ? r.expressId : toGlobalIdFromModels(models, r.modelId, r.expressId);
      // A geometry-less assembly (IfcElementAssembly, an IfcStair used as a
      // container, …) owns no mesh — the renderer highlights `selectedEntityIds`
      // directly, so selecting its bare id moved the camera there (frameSelection
      // resolves it) but left nothing lit up. Mirror HierarchyPanel's own click
      // handler (#1133): highlight the renderable parts too, with the assembly's
      // id LAST so it stays the primary selection (tree row stays highlighted,
      // Properties panel opens on the assembly, not an arbitrary part).
      const renderableParts = cameraCallbacks.resolveHighlightIds?.([globalId]) ?? [];
      setSelectedEntityIds([...renderableParts, globalId]);
      // setSelectedEntityIds doesn't touch selectedModelId, so a prior
      // model-header click (HierarchyPanel -> setSelectedModelId) leaves
      // PropertiesPanel stuck on ModelMetadataPanel. setSelectedEntityId
      // clears selectedModelId as its side effect (selectionSlice.ts).
      setSelectedEntityId(globalId);
      setSelectedEntity(ref);
      if (cameraCallbacks.frameSelection) {
        window.setTimeout(() => cameraCallbacks.frameSelection?.(), 50);
      }
      enterVimCycle(searchQuery, filtered, indexInFiltered);
      onClose();
    },
    [
      cameraCallbacks,
      enterVimCycle,
      filtered,
      models,
      onClose,
      searchQuery,
      setSelectedEntity,
      setSelectedEntityId,
      setSelectedEntityIds,
    ],
  );

  /**
   * Additive toggle — adds OR removes from multi-selection without
   * closing. Uses `toggleEntitySelection` so a second Shift+Enter (or
   * a second checkbox click on the same row) deselects, rather than
   * being a no-op that forces the user to clear the entire selection.
   */
  const toggleAdditive = useCallback(
    (r: SearchResult) => {
      toggleEntitySelection({ modelId: r.modelId, expressId: r.expressId });
    },
    [toggleEntitySelection],
  );

  /**
   * Batch: add every filtered result to multi-selection in a single
   * Zustand `set`. The naïve loop over `addEntityToSelection` triggered
   * one re-render per row — visibly janky on a 5K-row filtered set.
   */
  const selectAll = useCallback(() => {
    if (filtered.length === 0) return;
    addEntitiesToSelection(
      filtered.map((r) => ({ modelId: r.modelId, expressId: r.expressId })),
    );
  }, [addEntitiesToSelection, filtered]);

  /** Batch: frame whatever is the primary selection (if any). */
  const frame = useCallback(() => {
    cameraCallbacks.frameSelection?.();
  }, [cameraCallbacks]);

  const multiCount = selectedEntitiesSet.size;
  const hasModelChips = availableModelIds.length > 1;

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {/* ── Chip filters ── */}
      <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2 text-xs">
        <Filter className="h-3 w-3 text-muted-foreground" />
        <span className="mr-1 text-muted-foreground">{t('searchModal.text.fieldLabel')}</span>
        {FIELD_FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() => setSearchFieldFilter(f.value)}
            className={cn(
              'rounded border px-2 py-0.5 transition-colors',
              searchFieldFilter === f.value
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800',
            )}
          >
            {t(f.labelKey)}
          </button>
        ))}
        {hasModelChips && (
          <>
            <span className="mx-2 h-4 w-px bg-zinc-300 dark:bg-zinc-700" />
            <span className="mr-1 text-muted-foreground">{t('searchModal.text.modelsLabel')}</span>
            {availableModelIds.map((id) => {
              const included = searchModelFilter === null || searchModelFilter.has(id);
              const model = models.get(id);
              const label = model?.name ?? id.slice(0, 6);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggleSearchModelFilter(id, availableModelIds)}
                  className={cn(
                    'rounded border px-2 py-0.5 transition-colors',
                    included
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-zinc-300 text-muted-foreground line-through hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800',
                  )}
                  title={id}
                >
                  {label}
                </button>
              );
            })}
            {searchModelFilter !== null && (
              <button
                type="button"
                onClick={clearSearchModelFilter}
                className="ml-1 text-2xs text-muted-foreground underline hover:text-foreground"
              >
                {t('searchModal.text.resetModelFilter')}
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Virtualized results list ── */}
      {/* Rich virtual rows cannot be represented by native select/options. */}
      {/* eslint-disable-next-line jsx-a11y/prefer-tag-over-role */}
      <div role="listbox"
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto"
        aria-label={t('searchModal.text.resultsAriaLabel')}
        aria-activedescendant={filtered[searchHighlightIndex] ? resultOptionId(filtered[searchHighlightIndex]) : undefined}
        tabIndex={0}
        onClick={(event) => {
          const option = (event.target as Element).closest<HTMLElement>('[data-result-index]');
          if (!option || !event.currentTarget.contains(option)) return;
          const index = Number(option.dataset.resultIndex);
          const target = filtered[index];
          if (!target) return;
          if (event.shiftKey) toggleAdditive(target);
          else commit(target, index);
        }}
        onKeyDown={(e) => {
          if (e.target instanceof HTMLInputElement && e.target.type === 'checkbox') return;
          if (filtered.length === 0) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            const next = (searchHighlightIndex + 1) % filtered.length;
            setSearchHighlightIndex(next);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const next = (searchHighlightIndex - 1 + filtered.length) % filtered.length;
            setSearchHighlightIndex(next);
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const target = filtered[searchHighlightIndex];
            if (target) {
              if (e.shiftKey) toggleAdditive(target);
              else commit(target, searchHighlightIndex);
            }
          }
        }}
      >
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            {t(results.length === 0 ? 'searchModal.text.emptyPrompt' : 'searchModal.text.noMatches')}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vRow) => {
              const r = filtered[vRow.index];
              const key = `${r.modelId}:${r.expressId}`;
              const isChecked = selectedEntitiesSet.has(key);
              const isHighlighted = vRow.index === searchHighlightIndex;
              return (
                // Virtual options contain a checkbox and rich IFC metadata.
                // eslint-disable-next-line jsx-a11y/prefer-tag-over-role
                <div role="option"
                  key={key}
                  id={resultOptionId(r)}
                  tabIndex={-1}
                  data-result-index={vRow.index}
                  aria-selected={isHighlighted}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: vRow.size,
                    transform: `translateY(${vRow.start}px)`,
                  }}
                  className={cn(
                    'flex items-center gap-2 border-b border-zinc-100 px-4 text-xs dark:border-zinc-900',
                    isHighlighted && 'bg-zinc-100 dark:bg-zinc-800',
                  )}
                  onMouseEnter={() => setSearchHighlightIndex(vRow.index)}
                >
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleAdditive(r)}
                    aria-label={t('searchModal.text.toggleRowAriaLabel', { name: r.name || r.globalId })}
                    className="shrink-0 cursor-pointer"
                  />
                  <Badge variant="secondary" className="shrink-0 font-mono text-2xs uppercase">
                    {r.typeName}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {r.name || <span className="italic text-muted-foreground">{t('searchModal.text.unnamed')}</span>}
                  </span>
                  {r.globalId && (
                    <span className="shrink-0 font-mono text-2xs text-muted-foreground">
                      {r.globalId.slice(0, 10)}…
                    </span>
                  )}
                  {availableModelIds.length > 1 && (
                    <span className="shrink-0 rounded border border-zinc-300 px-1 py-0.5 text-2xs text-muted-foreground dark:border-zinc-700">
                      {(models.get(r.modelId)?.name ?? r.modelId).slice(0, 8)}
                    </span>
                  )}
                  <span className="shrink-0 text-2xs uppercase text-muted-foreground opacity-60">
                    {r.matchField}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Footer: counts + batch actions ── */}
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs">
        <span className="text-muted-foreground">
          {t('searchModal.text.resultCount', { count: filtered.length })}
          {filtered.length !== results.length && (
            <span className="ml-1 opacity-70">{t('searchModal.text.ofTotal', { total: results.length })}</span>
          )}
          {multiCount > 0 && (
            <span className="ml-2 font-medium text-foreground">{t('searchModal.text.selectedCount', { count: multiCount })}</span>
          )}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={frame}
            disabled={!cameraCallbacks.frameSelection}
            title={t('searchModal.text.frameTitle')}
            className="h-7 gap-1 text-xs"
          >
            <Crosshair className="h-3 w-3" />
            {t('searchModal.text.frameLabel')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={selectAll}
            disabled={filtered.length === 0}
            title={t('searchModal.text.selectAllTitle', { count: filtered.length })}
            className="h-7 gap-1 text-xs"
          >
            <ListChecks className="h-3 w-3" />
            {t('searchModal.text.selectAllLabel')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={clearEntitySelection}
            disabled={multiCount === 0}
            title={t('searchModal.text.clearSelectionTitle')}
            className="h-7 gap-1 text-xs"
          >
            <SquareX className="h-3 w-3" />
            {t('searchModal.text.clearSelectionLabel')}
          </Button>
        </div>
      </div>
    </div>
  );
}
