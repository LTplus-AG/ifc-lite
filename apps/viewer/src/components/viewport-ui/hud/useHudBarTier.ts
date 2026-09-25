/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, useState } from 'react';
import { getHudLaneRulerNode, subscribeHudRegions } from './hud-regions';

/**
 * Picks the widest form of a top-center `HudToolbar` that still fits the lane
 * as ONE row (#5975, charter #5478). `top-center` is capped at
 * `calc(100% - 28rem)` (`ViewportHud`), and a bar wider than that wraps onto a
 * second row: correct as a collision fallback, but it reads as heavy. So a bar
 * offers progressively smaller forms (tier 0 = full, then fewer inline
 * controls) and renders the first one that fits.
 *
 * Two independent widths are compared:
 *
 *  - `measureRef(tier)` goes on an offscreen (`fixed`, hidden, `flex-nowrap`)
 *    copy of that tier's content, one copy per measured tier. They sit outside
 *    the region, so the cap never constrains them, and they keep measuring
 *    while the visible bar shows a smaller form. That lets the bar grow back
 *    when a side panel closes; a bar measuring itself never could.
 *  - the lane ruler (`ViewportHud`) is a childless `w-full` box with the
 *    region's classes, so its laid-out width is the cap itself. Neither the
 *    shrink-to-fit region nor its computed `max-width` (an unresolved `calc()`
 *    string in Chromium) can report that.
 *
 * Returns the first of `measured` tiers whose width fits, else `measured`:
 * the smallest form, never measured, which keeps `HudToolbar`'s wrap as its
 * last-resort fallback. Tier 0 until both widths are known (no layout, e.g.
 * happy-dom without a ResizeObserver).
 */
export function useHudBarTier(measured: number): {
  measureRef: (tier: number) => (node: HTMLDivElement | null) => void;
  tier: number;
} {
  const nodes = useRef<(HTMLDivElement | null)[]>([]);
  const [widths, setWidths] = useState<(number | null)[]>([]);
  const [laneWidth, setLaneWidth] = useState<number | null>(null);
  // Bumped when a measured node (re)attaches, so the observer effect below
  // re-runs for nodes that mount after this hook's first render.
  const [generation, setGeneration] = useState(0);

  // One ref callback per tier, created ONCE. A callback with a new identity
  // each render is detached and reattached by React every commit; each
  // reattach bumps `generation`, and the re-render repeats that forever
  // ("Maximum update depth exceeded", pinned by this hook's test).
  const [refs] = useState(() =>
    Array.from({ length: measured }, (_, i) => (node: HTMLDivElement | null) => {
      if (nodes.current[i] === node) return;
      nodes.current[i] = node;
      setGeneration((g) => g + 1);
    }),
  );

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const update = () => {
      const next = nodes.current.map((n) => (n ? n.getBoundingClientRect().width : null));
      setWidths((prev) => (prev.length === next.length && prev.every((w, i) => w === next[i]) ? prev : next));
    };
    update();
    const ro = new ResizeObserver(update);
    for (const n of nodes.current) if (n) ro.observe(n);
    return () => ro.disconnect();
  }, [generation]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    let ro: ResizeObserver | null = null;
    let observed: HTMLDivElement | null = null;
    const attach = () => {
      const ruler = getHudLaneRulerNode();
      if (ruler === observed) return;
      ro?.disconnect();
      ro = null;
      observed = ruler;
      if (!ruler) {
        setLaneWidth(null);
        return;
      }
      const update = () => setLaneWidth(ruler.getBoundingClientRect().width);
      update();
      ro = new ResizeObserver(update);
      ro.observe(ruler);
    };
    attach();
    const unsubscribe = subscribeHudRegions(attach);
    return () => {
      unsubscribe();
      ro?.disconnect();
    };
  }, []);

  return { measureRef: (tier) => refs[tier], tier: pickHudBarTier(widths, laneWidth, measured) };
}

/** The first measured tier whose width fits `laneWidth`, else `measured`
 *  (the smallest, unmeasured form). Tier 0 while anything is unknown. */
export function pickHudBarTier(widths: readonly (number | null)[], laneWidth: number | null, measured: number): number {
  if (laneWidth == null || laneWidth <= 0) return 0;
  for (let i = 0; i < measured; i++) {
    const w = widths[i];
    if (w == null) return 0;
    if (w <= laneWidth) return i;
  }
  return measured;
}
