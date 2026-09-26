/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `SearchInline`'s vim-cycle hint and popover bodies (#5817 review: moving
 * the dropdown onto `@radix-ui/react-popover` grew `SearchInline.tsx` past
 * its allowlisted module-size budget). Content is unchanged from before the
 * split — this is a pure extraction, not a behavior change.
 */

import { Search, Clock, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from '@/i18n';
import { selectorYieldsRules } from '@/lib/search/selector-to-rules';
import type { SearchResult } from '@/lib/search/tier0-scan';

interface VimCycleHintProps {
  query: string;
  index: number;
  total: number;
  onExit: () => void;
}

export function VimCycleHint({ query, index, total, onExit }: VimCycleHintProps) {
  const { t } = useTranslation();
  return (
    <div
      className="absolute left-0 right-0 top-full mt-1 flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-2xs text-muted-foreground shadow-sm dark:border-zinc-800 dark:bg-zinc-950 z-40"
      role="status"
      aria-live="polite"
    >
      <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
        {index + 1} / {total}
      </span>
      <span className="truncate">
        <span className="opacity-70">{t('searchModal.inline.cyclingPrefix')}</span>
        <span className="font-mono">&quot;{query}&quot;</span>
        <span className="opacity-70">{t('searchModal.inline.cyclingPressHint')}</span>
        <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1 font-mono text-2xs dark:border-zinc-700 dark:bg-zinc-900">{t('searchModal.inline.cycleNextKey')}</kbd>
        <span className="opacity-70"> / </span>
        <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1 font-mono text-2xs dark:border-zinc-700 dark:bg-zinc-900">{t('searchModal.inline.cyclePrevKey')}</kbd>
      </span>
      <button
        type="button"
        className="ml-auto rounded p-0.5 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        aria-label={t('searchModal.inline.exitCycleAriaLabel')}
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

/** Rendered as `PopoverContent`'s children in `SearchInline` (#5817) — no
 *  wrapping element of its own, since the id/role/positioning/border now
 *  live on `PopoverContent`. */
export function RecentsPopoverBody({ recents, onPick, onClear }: RecentsPopoverProps) {
  const { t } = useTranslation();
  return (
    <div className="py-1">
      <div className="flex items-center justify-between px-3 py-1 text-2xs uppercase tracking-wider text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {t('searchModal.inline.recentSearches')}
        </span>
        <button
          type="button"
          className="text-2xs normal-case hover:underline"
          onMouseDown={(e) => {
            e.preventDefault();
            onClear();
          }}
        >
          {t('searchModal.inline.clearRecents')}
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
  query: string;
  highlightIndex: number;
  modelsCount: number;
  indexingCount: number;
  onSelect: (r: SearchResult, index: number, additive: boolean) => void;
  onHover: (index: number) => void;
  onOpenAdvanced: () => void;
}

/** Rendered as `PopoverContent`'s children in `SearchInline` (#5817) — see
 *  `RecentsPopoverBody`'s note; the id/role/positioning/border now live on
 *  `PopoverContent`, not on either branch's own root here. */
export function SearchPopoverBody({
  results,
  query,
  highlightIndex,
  modelsCount,
  indexingCount,
  onSelect,
  onHover,
  onOpenAdvanced,
}: SearchPopoverProps) {
  const { t } = useTranslation();
  if (results.length === 0) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground">
        {indexingCount > 0
          ? t('searchModal.inline.indexingHint', { count: indexingCount })
          : selectorYieldsRules(query) ? t('searchModal.inline.selectorSyntaxHint') : t('searchModal.inline.noResultsHint')}
      </div>
    );
  }

  return (
    <div className="max-h-96 overflow-y-auto py-1">
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
          <span className="shrink-0 rounded bg-zinc-200 px-1.5 py-0.5 font-mono text-2xs uppercase text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {r.typeName}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium">
            {r.name || <span className="italic text-muted-foreground">{t('searchModal.inline.unnamed')}</span>}
          </span>
          {r.globalId && (
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">
              {r.globalId.slice(0, 8)}…
            </span>
          )}
          {modelsCount > 1 && (
            <span className="shrink-0 rounded border border-zinc-300 px-1 py-0.5 text-2xs text-muted-foreground dark:border-zinc-700">
              {r.modelId.slice(0, 6)}
            </span>
          )}
        </button>
      ))}
      <div className="flex items-center gap-2 border-t border-zinc-200 px-3 py-1 text-2xs text-muted-foreground dark:border-zinc-800">
        <span>
          {t('searchModal.inline.resultCountHint', { count: results.length })}
          {indexingCount > 0 && <span className="ml-2 opacity-80">{t('searchModal.inline.indexingCountHint', { count: indexingCount })}</span>}
        </span>
        <button
          type="button"
          className="ml-auto hover:underline"
          onMouseDown={(e) => {
            e.preventDefault();
            onOpenAdvanced();
          }}
        >
          {t('searchModal.inline.advanced')} <kbd className="ml-0.5 rounded border border-zinc-300 bg-zinc-100 px-1 font-mono text-2xs dark:border-zinc-700 dark:bg-zinc-900">⌘↵</kbd>
        </button>
      </div>
    </div>
  );
}
