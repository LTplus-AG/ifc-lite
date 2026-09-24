/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  getHudRegionNode,
  registerHudItem,
  subscribeHudRegions,
  unregisterHudItem,
  type HudRegionName,
} from './hud-regions';

export interface HudItemProps {
  /** Which of `ViewportHud`'s six regions this mounts into. */
  region: HudRegionName;
  /**
   * Real DOM order within the region; lower sorts first (ties keep
   * registration order). This is the ONLY placement knob — there is no
   * x/y, so a new tool cannot invent a position that collides with
   * another's.
   */
  order: number;
  children: ReactNode;
  className?: string;
}

/**
 * Portals `children` into one of `ViewportHud`'s six regions (#5485, charter
 * #5478 item 3), wrapped in a `data-hud-item` marker the layout gates key
 * off (the HUD collision e2e, #5478 item 5's `check-overlay-palette`-style
 * check).
 *
 * Placement is by `region` + `order`, resolved through the module-level
 * registry in `hud-regions.ts` — so a tool bar mounted from `ToolOverlays`
 * (a sibling of `ViewportHud`, not a descendant) portals in exactly the same
 * way a HUD-internal consumer would.
 *
 * Ordering is REAL DOM order, not CSS `order` (PR #5631 review): this item
 * owns one stable wrapper node for its whole lifetime (`useState`'s lazy
 * initializer runs once) and portals `children` into it, so React's
 * reconciliation of `children` is unaffected by anything below; `hud-regions
 * .ts`'s `registerHudItem` is the only code that ever re-`appendChild`s a
 * region's children, always in ascending `order`, so the container's actual
 * child list — what a browser lays out and what a test can walk — is always
 * the sorted list, not just its paint order.
 *
 * Renders nothing until `ViewportHud` has published the target region's DOM
 * node: a `HudItem` mounted before (or without) the HUD host is simply not
 * shown rather than throwing, so tool components don't need to sequence
 * their mount against the HUD's.
 */
export function HudItem({ region, order, children, className }: HudItemProps) {
  const id = useId();
  const [node] = useState(() => {
    const el = document.createElement('div');
    el.dataset.hudItem = '';
    return el;
  });

  const regionNode = useSyncExternalStore(
    subscribeHudRegions,
    () => getHudRegionNode(region),
    () => null,
  );

  useEffect(() => {
    node.className = className ?? '';
  }, [node, className]);

  useEffect(() => {
    if (!regionNode) return;
    registerHudItem(region, id, order, node);
    return () => unregisterHudItem(region, id);
  }, [regionNode, region, id, order, node]);

  if (!regionNode) return null;
  return createPortal(children, node);
}
