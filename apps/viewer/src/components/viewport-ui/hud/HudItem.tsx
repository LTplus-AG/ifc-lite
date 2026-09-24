/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { getHudRegionNode, subscribeHudRegions, type HudRegionName } from './hud-regions';

export interface HudItemProps {
  /** Which of `ViewportHud`'s six regions this mounts into. */
  region: HudRegionName;
  /**
   * Flex `order` within the region; lower sorts first (ties keep DOM/mount
   * order). This is the ONLY placement knob — there is no x/y, so a new
   * tool cannot invent a position that collides with another's.
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
 * Renders nothing until `ViewportHud` has published the target region's DOM
 * node: a `HudItem` mounted before (or without) the HUD host is simply not
 * shown rather than throwing, so tool components don't need to sequence
 * their mount against the HUD's.
 */
export function HudItem({ region, order, children, className }: HudItemProps) {
  const node = useSyncExternalStore(
    subscribeHudRegions,
    () => getHudRegionNode(region),
    () => null,
  );
  if (!node) return null;
  const style: CSSProperties = { order };
  return createPortal(
    <div data-hud-item className={className} style={style}>
      {children}
    </div>,
    node,
  );
}
