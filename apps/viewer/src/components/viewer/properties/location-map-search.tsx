/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `LocationMap`'s place-search bar and its results dropdown, split out of
 * `LocationMap.tsx` (#5817 review: moving the results list onto
 * `ui/popover.tsx` grew that file past its allowlisted module-size
 * budget). Content and behavior are unchanged from before the split.
 *
 * The reveal itself (this whole bar) is a plain conditional render — it
 * pushes the map down, it doesn't float over it — so only the results
 * LIST is a genuine floating overlay, and only that part is the
 * `ui/popover.tsx` Radix Popover.
 */

import { Loader2, MapPin, X } from 'lucide-react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import type { GeocodeResult } from './location-map-geocode';

interface LocationMapSearchBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  results: GeocodeResult[];
  onResultsChange: (results: GeocodeResult[]) => void;
  loading: boolean;
  placeholder: string;
  onSelect: (result: GeocodeResult) => void;
  onClose: () => void;
}

export function LocationMapSearchBar({
  query,
  onQueryChange,
  results,
  onResultsChange,
  loading,
  placeholder,
  onSelect,
  onClose,
}: LocationMapSearchBarProps) {
  return (
    <div className="px-3 pb-1.5 relative">
      <div className="flex items-center gap-1">
        <Popover
          open={results.length > 0}
          onOpenChange={(next) => { if (!next) onResultsChange([]); }}
        >
          <PopoverAnchor asChild>
            <div className="flex-1 relative">
              <input
                value={query}
                onChange={e => onQueryChange(e.target.value)}
                placeholder={placeholder}
                className="w-full text-[11px] px-2 py-1 border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:ring-1 focus:ring-teal-400 focus:border-teal-400 placeholder:text-zinc-400/60"
                autoFocus
                onKeyDown={e => { if (e.key === 'Escape') onClose(); }}
              />
              {loading && (
                <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-teal-500 animate-spin" />
              )}
            </div>
          </PopoverAnchor>
          {/* Focus stays on the input the whole time (it isn't a combobox
              with arrow-key navigation, but the search bar's own
              Escape/close-button handling still expects it to), so
              autofocus into/out of the list and Radix's focus-outside read
              of the anchor (a sibling of Content, not a descendant — see
              SearchInline's `PopoverContent` for the same note) are all
              suppressed. Real dismissal (Esc, outside click) still runs
              through `onOpenChange` above. */}
          <PopoverContent
            align="start"
            sideOffset={2}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onFocusOutside={(e) => e.preventDefault()}
            style={{ width: 'var(--radix-popper-anchor-width)' }}
            className="max-h-[160px] overflow-y-auto bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 p-0 shadow-lg"
          >
            {results.map((r, i) => (
              <button
                key={i}
                onClick={() => onSelect(r)}
                className="w-full text-left px-2 py-1.5 text-[10px] text-zinc-700 dark:text-zinc-300 hover:bg-teal-50 dark:hover:bg-teal-950/50 border-b border-zinc-100 dark:border-zinc-800 last:border-0 transition-colors"
              >
                <div className="flex items-start gap-1.5">
                  <MapPin className="h-3 w-3 text-teal-500 shrink-0 mt-0.5" />
                  <span className="line-clamp-2">{r.display_name}</span>
                </div>
              </button>
            ))}
          </PopoverContent>
        </Popover>
        <button
          onClick={onClose}
          className="p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
