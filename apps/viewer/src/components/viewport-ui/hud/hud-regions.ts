/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Module-level registry mapping each `ViewportHud` region to its live DOM
 * node (#5485, charter #5478).
 *
 * `HudItem` needs to portal into a region no matter where it sits in the
 * React tree — a tool bar mounted from `ToolOverlays` in a later item is not
 * a descendant of `ViewportHud` — so the six region nodes are published here
 * rather than through React context. Same `subscribe`/`getSnapshot` shape
 * `flySpeedStore` (`components/viewer/flySpeedStore.js`) already uses
 * elsewhere in the viewer for the same reason: a plain module store, read
 * via `useSyncExternalStore`, needs no provider anywhere in the tree.
 *
 * There is exactly one `ViewportHud` per app instance, so a single
 * module-scoped map (not one scoped to a provider) is the right shape.
 */

export const HUD_REGIONS = [
  'top-left',
  'top-center',
  'top-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;

export type HudRegionName = (typeof HUD_REGIONS)[number];

const nodes = new Map<HudRegionName, HTMLDivElement>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Register (or, passing `null`, clear) the live DOM node backing a region.
 * `ViewportHud` calls this from each region's callback ref, so the node is
 * published on mount and cleared on unmount.
 */
export function setHudRegionNode(name: HudRegionName, node: HTMLDivElement | null): void {
  const current = nodes.get(name) ?? null;
  if (current === node) return;
  if (node) nodes.set(name, node);
  else nodes.delete(name);
  notify();
}

/** The current DOM node for a region, or `null` if no `ViewportHud` is mounted. */
export function getHudRegionNode(name: HudRegionName): HTMLDivElement | null {
  return nodes.get(name) ?? null;
}

/** Subscribe to region-node changes (`useSyncExternalStore`'s `subscribe`). */
export function subscribeHudRegions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
