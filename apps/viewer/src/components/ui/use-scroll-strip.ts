/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A tab strip that may be wider than its box (#8802): Settings' sections and
 * the Info dialog's tabs on a phone. `TabsList scrollable` uses this; the
 * strip itself scrolls sideways (`[data-scroll-strip]` in `index.css`).
 *
 * - `fade` names the edges that hide tabs, for `[data-scroll-fade]`, so a
 *   strip that ends exactly at a tab boundary still reads as scrollable.
 * - The selected tab is kept in view when the selection or the strip's size
 *   changes, never while the user scrolls.
 */

import { useCallback, useEffect, useLayoutEffect, useState, type ForwardedRef } from 'react';

export type ScrollFade = 'start' | 'end' | 'both' | undefined;

function fadeOf(strip: HTMLElement): ScrollFade {
  const start = strip.scrollLeft > 1;
  const end = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
  return start && end ? 'both' : start ? 'start' : end ? 'end' : undefined;
}

/** Scrolls the selected tab into view, clear of the fade. It scrolls only the
 *  strip: `scrollIntoView` would also scroll the dialog, which clips with
 *  `overflow: hidden`. Self-contained, so a layout test can run it in Chrome. */
export function revealSelected(strip: HTMLElement): void {
  const fadePx = 32; // `[data-scroll-fade]` in index.css: 2rem
  const max = strip.scrollWidth - strip.clientWidth;
  if (max <= 1) return;
  const tab = strip.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
  if (!tab) return;
  const box = strip.getBoundingClientRect();
  const { left, right } = tab.getBoundingClientRect();
  let target = strip.scrollLeft;
  if (left < box.left + fadePx) target -= box.left + fadePx - left;
  else if (right > box.right - fadePx) target += right - (box.right - fadePx);
  strip.scrollLeft = Math.max(0, Math.min(max, target));
}

function assignRef<T>(ref: ForwardedRef<T>, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

export function useScrollStrip<T extends HTMLElement>(
  enabled: boolean,
  forwardedRef: ForwardedRef<T>,
): { setStrip: (node: T | null) => void; fade: ScrollFade } {
  // State, not a ref: a dialog portals its content a render after it opens.
  const [node, setNode] = useState<T | null>(null);
  const [fade, setFade] = useState<ScrollFade>();
  // A plain tab list only forwards its ref: no state, no extra render.
  const setStrip = useCallback((next: T | null) => {
    if (enabled) setNode(next);
    assignRef(forwardedRef, next);
  }, [enabled, forwardedRef]);
  const strip = enabled ? node : null;

  // Labels can change width without the strip's own box changing (a language
  // switch), so the fade is recomputed after every render of the strip.
  useLayoutEffect(() => {
    if (strip) setFade(fadeOf(strip));
  });

  useEffect(() => {
    if (!strip) return;
    const update = () => setFade(fadeOf(strip));
    const reveal = () => {
      revealSelected(strip);
      update();
    };
    reveal();
    strip.addEventListener('scroll', update, { passive: true });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reveal);
    resize?.observe(strip);
    for (const item of strip.children) resize?.observe(item);
    const selection = typeof MutationObserver === 'undefined' ? null : new MutationObserver(reveal);
    selection?.observe(strip, { subtree: true, attributes: true, attributeFilter: ['data-state'] });
    return () => {
      strip.removeEventListener('scroll', update);
      resize?.disconnect();
      selection?.disconnect();
    };
  }, [strip]);

  return { setStrip, fade: strip ? fade : undefined };
}
