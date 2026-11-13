/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tidies the ribbon band when a host switched features off (`lib/features`).
 *
 * A command that is off renders no button. That can leave a group with only
 * its label, and dividers that no longer separate anything. Each tab lays its
 * groups out by hand, some inside wrappers, so no tab can tell on its own
 * whether a neighbour's group ended up empty; the band can, by looking at
 * what actually rendered. An empty group is hidden, and a divider stays only
 * between two groups that show.
 *
 * With every feature on this does nothing at all: no observer, no style.
 */

import { useCallback, useRef } from 'react';
import { isAnyFeatureDisabled } from '@/lib/features';

const CONTROL = 'button, input, select, a[href]';

function show(node: Element, visible: boolean): void {
  (node as HTMLElement).style.display = visible ? '' : 'none';
}

/** Hide the groups of `band` that hold no control, and the dividers left without two groups to separate. */
export function collapseEmptyRibbonGroups(band: Element): void {
  let groupShownBefore = false;
  let divider: Element | null = null;
  for (const node of band.querySelectorAll('[data-ribbon-group], [data-ribbon-divider]')) {
    if (node.hasAttribute('data-ribbon-divider')) {
      show(node, false);
      // The first divider after a shown group is the one that may separate it from the next.
      if (groupShownBefore && !divider) divider = node;
      continue;
    }
    const empty = node.querySelector(CONTROL) === null;
    show(node, !empty);
    if (empty) continue;
    if (divider) show(divider, true);
    divider = null;
    groupShownBefore = true;
  }
}

/** A ref for the band element. It keeps the band tidy while it is mounted. */
export function useRibbonBandCollapse(): (band: HTMLElement | null) => void {
  const observer = useRef<MutationObserver | null>(null);
  return useCallback((band: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!band || !isAnyFeatureDisabled()) return;
    collapseEmptyRibbonGroups(band);
    // Tabs re-render on their own (a selection, a loaded model); only added or
    // removed nodes matter, and the style writes above are not such changes.
    observer.current = new MutationObserver(() => collapseEmptyRibbonGroups(band));
    observer.current.observe(band, { childList: true, subtree: true });
  }, []);
}
