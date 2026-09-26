/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Searchable dropdown (for large dynamic lists), used throughout `LensPanel`'s
 * rule/auto-color editors (#1924, #1958).
 *
 * Extracted into its own module (#1958 review) so the two test files that
 * exercise it don't need to import `LensPanel.tsx`'s whole component graph —
 * including the Zustand store, which touches browser globals at module init —
 * just to reach a self-contained popup component.
 *
 * The popup moved onto Radix (`ui/popover.tsx`, #5817): it used to be a
 * hand-rolled `createPortal` with its own `getBoundingClientRect`-based
 * flip/clamp math (`computeSearchableSelectAnchor`), its own `document`
 * `mousedown` listener for outside-click, and its own `resolveTriggerWindow`/
 * `resolveTriggerDocument` helpers to make both of those correct for a panel
 * popped out into its own OS / PiP window (#1208). All three are gone —
 * floating-ui (which Radix's `Popover.Content` is built on) already resolves
 * an anchor's owning window/document from the anchor DOM node itself
 * (`getWindow`/`getDocumentElement` internally), so `avoidCollisions` flips
 * up against the trigger's OWN window's viewport without any bespoke code,
 * and `PopoverPortal container={usePortalContainer()}` is the SAME
 * app-standard portal-container mechanism `ui/dialog.tsx` and
 * `ui/dropdown-menu.tsx` already use for the identical popped-out-window
 * case — SearchableSelect was the one outlier hand-rolling it before.
 */

import { useMemo, useState } from 'react';
import { Search, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '@/components/ui/popover';
import { usePortalContainer } from '@/components/ui/portal-container';
import { useTranslation } from '@/i18n';

/** Popup's own CSS `max-h` ceiling, via `min()` against
 *  `--radix-popper-available-height` (the space floating-ui measured on
 *  the side it actually placed the popup) — never exceeds this even when
 *  there's abundant space, so the popup stays a sane size, and never
 *  overflows the trigger's own window's viewport either. */
const SEARCHABLE_SELECT_POPUP_MAX_HEIGHT = 200;

/** Matches the `collisionPadding` kept between the popup's far edge and the
 *  viewport edge it's clamped against (#1958 review: a flush clamp is one
 *  rounding error away from a 1px off-screen sliver). */
const SEARCHABLE_SELECT_EDGE_MARGIN = 8;

/** Exported for `SearchableSelect.test.tsx` — rendering it directly avoids
 *  mounting the whole panel (store, discovered data, etc). */
export function SearchableSelect({
  value,
  options,
  onChange,
  placeholder,
  className,
  displayFn,
}: {
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  displayFn?: (v: string) => string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const portalContainer = usePortalContainer();

  const filtered = useMemo(() => {
    if (!filter) return options;
    const q = filter.toLowerCase();
    return options.filter(o => o.toLowerCase().includes(q));
  }, [options, filter]);

  const display = displayFn ?? ((v: string) => v);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFilter('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'w-full flex items-center justify-between gap-1 text-left',
            'text-xs px-1.5 py-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 rounded-sm',
            !value && 'text-zinc-400 dark:text-zinc-500',
            className,
          )}
        >
          <span className="truncate">{value ? display(value) : (placeholder ?? t('searchableSelect.defaultPlaceholder'))}</span>
          <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      {/* Portals straight to <body> (or the popped-out panel window's body,
          #1208, via `usePortalContainer()`) so it clears every
          `overflow-hidden`/`overflow-auto` clipping ancestor between the
          trigger and the viewport — the panel's scroll container, the
          floating-panel chrome, the docked-panel host (#1924). */}
      <PopoverPortal container={portalContainer}>
        <PopoverContent
          data-testid="searchable-select-popup"
          side="bottom"
          align="start"
          sideOffset={2}
          collisionPadding={SEARCHABLE_SELECT_EDGE_MARGIN}
          avoidCollisions
          // Filter input (when present) gets its own focus effect below;
          // Radix's own mount-autofocus would otherwise fight it.
          onOpenAutoFocus={(e) => {
            if (options.length <= 8) e.preventDefault();
          }}
          // Stop pointerdown from bubbling past the popup into a host
          // dialog's own dismissable layer, so picking a value doesn't also
          // close it.
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            width: 'var(--radix-popper-anchor-width)',
            maxHeight: `min(${SEARCHABLE_SELECT_POPUP_MAX_HEIGHT}px, var(--radix-popper-available-height))`,
          }}
          // `popover-surface` is load-bearing, not cosmetic (#1924 / #1972):
          // `.colorful .bg-white` is overridden to `var(--cf-glass)` at 48%
          // alpha with `!important`, so in that theme the `bg-white` below is
          // exactly what makes the popup see-through. The `.colorful
          // .popover-surface` rule (declared after it in `index.css`) reclaims
          // an opaque background and disables the `backdrop-filter` that would
          // otherwise create a stacking context and invert paint order.
          // Removing this class silently reopens #1924.
          className="popover-surface z-[120] p-0 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded-sm shadow-lg flex flex-col"
        >
          {options.length > 8 && (
            <div className="flex items-center gap-1 px-1.5 py-1 border-b border-zinc-200 dark:border-zinc-700">
              <Search className="h-3 w-3 text-zinc-400 flex-shrink-0" />
              <input
                // eslint-disable-next-line jsx-a11y/no-autofocus -- keeps the filter typeable the instant the popup opens, matching the pre-#5817 focus timing.
                autoFocus
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={t('searchableSelect.searchPlaceholder')}
                className="flex-1 text-xs bg-transparent border-0 outline-none text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
              />
            </div>
          )}
          <div className="overflow-y-auto flex-1">
            {filtered.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('searchableSelect.noMatches')}</div>
            )}
            {filtered.map(opt => (
              <button
                key={opt}
                type="button"
                className={cn(
                  'w-full text-left px-2 py-1 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-700 truncate',
                  opt === value && 'bg-primary/10 text-primary font-medium',
                )}
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                  setFilter('');
                }}
              >
                {display(opt)}
              </button>
            ))}
          </div>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
