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
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePortalContainer } from '@/components/ui/portal-container';

/** Popup's own CSS `max-h` ceiling — the flip/clamp math never exceeds this,
 *  even when there's abundant space, so the popup stays a sane size. */
const SEARCHABLE_SELECT_POPUP_MAX_HEIGHT = 200;

/** Minimum on-screen gap kept between the popup's far edge and the viewport
 *  edge it's clamped against, so the clamp lands strictly on-screen rather
 *  than exactly flush with it (#1958 review: a flush clamp is one rounding
 *  error away from a 1px off-screen sliver). */
const SEARCHABLE_SELECT_EDGE_MARGIN = 8;

/** Fixed-position coordinates for the portaled popup, computed from the trigger's rect. */
interface SearchableSelectAnchor {
  left: number;
  width: number;
  /** Distance from the viewport top to the trigger's bottom (used when opening down). */
  top: number;
  /** Distance from the viewport bottom to the trigger's top (used when opening up). */
  bottom: number;
  openUp: boolean;
  /** Clamped popup height in px — never exceeds the available space on the
   *  side the popup opens toward, so it can't push its own top (when open up)
   *  or bottom (when open down) off-screen. See `computeSearchableSelectAnchor`. */
  maxHeight: number;
}

/**
 * Resolve the `Window` that owns `el`, for viewport-relative measurements
 * and scroll/resize listeners. A panel popped out into its own OS / PiP
 * window (#1208) renders `SearchableSelect`'s trigger in *that* window's
 * document, not the main tab's — using the global `window` there computes
 * the flip decision against the wrong viewport height and attaches
 * scroll/resize listeners to the wrong window, so the popup never
 * repositions when the child window scrolls or resizes.
 *
 * `ownerDocument.defaultView` is the standard way to recover an element's
 * window; it is `null` only for a document detached from any window (e.g.
 * one created via `DOMParser` or `document.implementation.createDocument`,
 * never attached to a `<iframe>`/window). A mounted, visible trigger can't
 * be in a detached document, but we fall back to the global `window` rather
 * than asserting, since a stale ref during teardown is a more plausible way
 * to hit this than a truly detached document.
 */
export function resolveTriggerWindow(el: HTMLElement): Window {
  return el.ownerDocument.defaultView ?? window;
}

/**
 * Resolve the `Document` that owns `el`, for the outside-click listener and
 * the popup's portal fallback target. A panel popped out into its own OS /
 * PiP window (#1208) renders `SearchableSelect`'s trigger in *that* window's
 * document, not the main tab's — attaching the outside-click listener to the
 * global `document` there means a click inside the child window never
 * reaches it, so the popup never closes; and falling back to the global
 * `document.body` for the portal mounts the popup in the main tab instead of
 * the child window the trigger actually lives in.
 *
 * Unlike `defaultView` above, `ownerDocument` is never null for a connected
 * element, so there's no equivalent fallback to reach for here — this is a
 * direct passthrough, kept as its own named helper (mirroring
 * `resolveTriggerWindow`'s shape) purely so every call site resolves the
 * owning document the same way instead of re-deriving it.
 */
export function resolveTriggerDocument(el: HTMLElement): Document {
  return el.ownerDocument;
}

/**
 * Pure positioning math for `SearchableSelect`'s portaled popup (#1924): given
 * the trigger's viewport rect and the viewport height, decide whether the
 * popup opens down (default) or flips up, and return the `position: fixed`
 * coordinates for either case. Extracted so the flip decision is unit
 * testable without a DOM (`SearchableSelect.anchor.test.ts`).
 * Takes `viewportHeight` as a parameter rather than reading `window` itself
 * so callers can pass the *trigger's* window (`resolveTriggerWindow`) —
 * necessary for popped-out panel windows, see above.
 *
 * The returned `maxHeight` clamps the popup to whatever space is actually
 * available on the side it opens toward (#1958 review): without this, a
 * trigger with little room above but more than below could still flip up
 * (the `spaceAbove > spaceBelow` check only compares the two, it doesn't
 * check `spaceAbove` against the popup's own height), pushing the popup's
 * top — which for >8 options is the filter input — off the top of the
 * viewport. Because the popup is `position: fixed`, an off-screen slice like
 * that can never be scrolled back into view. Clamping the height (rather
 * than requiring `spaceAbove >= popupMaxHeight` before flipping) also helps
 * the *not-flipped* case, where space below is tight but still the better of
 * the two sides.
 */
export function computeSearchableSelectAnchor(
  triggerRect: { left: number; width: number; top: number; bottom: number },
  viewportHeight: number,
  popupMaxHeight: number = SEARCHABLE_SELECT_POPUP_MAX_HEIGHT,
): SearchableSelectAnchor {
  const spaceBelow = viewportHeight - triggerRect.bottom;
  const spaceAbove = triggerRect.top;
  // Flip up only when there isn't enough room below AND there's more room
  // above — otherwise keep the (already clipped-by-viewport, at least
  // visible-on-screen) default so we never flip into an even smaller gap.
  const openUp = spaceBelow < popupMaxHeight && spaceAbove > spaceBelow;
  const availableSpace = openUp ? spaceAbove : spaceBelow;
  const maxHeight = Math.max(0, Math.min(popupMaxHeight, availableSpace - SEARCHABLE_SELECT_EDGE_MARGIN));
  return {
    left: triggerRect.left,
    width: triggerRect.width,
    top: triggerRect.bottom,
    bottom: viewportHeight - triggerRect.top,
    openUp,
    maxHeight,
  };
}

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
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [anchor, setAnchor] = useState<SearchableSelectAnchor | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const portalContainer = usePortalContainer();

  const filtered = useMemo(() => {
    if (!filter) return options;
    const q = filter.toLowerCase();
    return options.filter(o => o.toLowerCase().includes(q));
  }, [options, filter]);

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const win = resolveTriggerWindow(el);
    setAnchor(computeSearchableSelectAnchor(el.getBoundingClientRect(), win.innerHeight));
  }, []);

  // The popup is portaled straight to <body> (or the popped-out panel
  // window's body, #1208) so it clears every `overflow-hidden`/`overflow-auto`
  // clipping ancestor between the trigger and the viewport — the panel's
  // scroll container, the floating-panel chrome, the docked-panel host (#1924).
  // Track the trigger's position while open (capture = also catch ancestor
  // scrolls, e.g. the panel's own scroll container) and flip up near the
  // bottom of the viewport instead of overflowing off-screen. Both the
  // viewport height above and these listeners must use the trigger's OWN
  // window (`resolveTriggerWindow`), not the global — in a popped-out panel
  // window the global `window` is still the main tab's, which has the wrong
  // viewport height and never fires scroll/resize for the child window.
  useLayoutEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) return;
    const win = resolveTriggerWindow(el);
    reposition();
    const onScroll = () => reposition();
    win.addEventListener('scroll', onScroll, true);
    win.addEventListener('resize', onScroll);
    return () => {
      win.removeEventListener('scroll', onScroll, true);
      win.removeEventListener('resize', onScroll);
    };
  }, [open, reposition]);

  // Close on outside click — the popup is portaled out of `containerRef`, so
  // it needs its own containment check.
  useEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) return;
    const doc = resolveTriggerDocument(el);
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current?.contains(target)) return;
      // Without this check, a mousedown on an option row closes the popup
      // (and unmounts the row) before that row's `click` fires — the row
      // never sees its own click, so picking a value silently does nothing
      // (#1958 review: see the "mousedown then click" regression test).
      if (popupRef.current?.contains(target)) return;
      setOpen(false);
      setFilter('');
    };
    doc.addEventListener('mousedown', handler);
    return () => doc.removeEventListener('mousedown', handler);
  }, [open]);

  const display = displayFn ?? ((v: string) => v);
  const showPopup = open && anchor !== null;

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setOpen(!open);
          if (!open) setTimeout(() => inputRef.current?.focus(), 0);
        }}
        className={cn(
          'w-full flex items-center justify-between gap-1 text-left',
          'text-xs px-1.5 py-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-900 dark:text-zinc-100 rounded-sm',
          !value && 'text-zinc-400 dark:text-zinc-500',
        )}
      >
        <span className="truncate">{value ? display(value) : (placeholder ?? 'Select...')}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0 opacity-50" />
      </button>
      {showPopup && triggerRef.current && createPortal(
        <div
          ref={popupRef}
          data-testid="searchable-select-popup"
          style={{
            position: 'fixed',
            left: anchor.left,
            width: anchor.width,
            // `maxHeight` here is load-bearing, not decorative: it clamps to
            // whatever space is actually available (#1958 review) and MUST
            // win over the `max-h-[200px]` Tailwind class below — an inline
            // style always beats a class of equal-or-lower specificity, so
            // this always applies, but keep the two in sync if either changes.
            maxHeight: anchor.maxHeight,
            ...(anchor.openUp
              ? { bottom: anchor.bottom + 2 }
              : { top: anchor.top + 2 }),
          }}
          // Stop pointerdown from bubbling past the popup (e.g. into a Radix
          // dismissable layer) so picking a value doesn't also close a host dialog.
          onPointerDown={(e) => e.stopPropagation()}
          // `popover-surface` is load-bearing, not cosmetic (#1924 / #1972):
          // `.colorful .bg-white` is overridden to `var(--cf-glass)` at 48%
          // alpha with `!important`, so in that theme the `bg-white` below is
          // exactly what makes the popup see-through. The `.colorful
          // .popover-surface` rule (declared after it in `index.css`) reclaims
          // an opaque background and disables the `backdrop-filter` that would
          // otherwise create a stacking context and invert paint order.
          // Removing this class silently reopens #1924.
          className="popover-surface z-[120] bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 rounded-sm shadow-lg max-h-[200px] flex flex-col"
        >
          {options.length > 8 && (
            <div className="flex items-center gap-1 px-1.5 py-1 border-b border-zinc-200 dark:border-zinc-700">
              <Search className="h-3 w-3 text-zinc-400 flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search..."
                className="flex-1 text-xs bg-transparent border-0 outline-none text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
              />
            </div>
          )}
          <div className="overflow-y-auto flex-1">
            {filtered.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-zinc-400">No matches</div>
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
        </div>,
        portalContainer ?? resolveTriggerDocument(triggerRef.current).body,
      )}
    </div>
  );
}
