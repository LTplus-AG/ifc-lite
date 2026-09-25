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

/**
 * The top-center lane ruler (#5975): an invisible, childless `width: 100%`
 * box carrying the SAME classes as the `top-center` region, so its laid-out
 * width is exactly the lane's cap. The region itself shrinks to fit its
 * children, and `getComputedStyle(region).maxWidth` comes back as the raw
 * `calc(100% - 448px)` string in Chromium, so neither can say how wide the
 * lane is. Published through the same listeners as the region nodes.
 */
let laneRulerNode: HTMLDivElement | null = null;

export function setHudLaneRulerNode(node: HTMLDivElement | null): void {
  if (laneRulerNode === node) return;
  laneRulerNode = node;
  notify();
}

export function getHudLaneRulerNode(): HTMLDivElement | null {
  return laneRulerNode;
}

/** Subscribe to region-node changes (`useSyncExternalStore`'s `subscribe`). */
export function subscribeHudRegions(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Item ordering (#5485 review, PR #5631 comment 4093922242).
 *
 * A CSS `order` on each item's wrapper only controls PAINT order, not real
 * DOM order — a test (or, in a real browser, any code that stops applying
 * that style) can observe stale DOM order and nothing catches it. So DOM
 * order is made to genuinely match `order`: each `HudItem` owns one stable
 * DOM node (created once via `useState`, portaled into for the item's whole
 * lifetime — see `HudItem.tsx`) and registers it here; this module is the
 * ONLY thing that ever calls `appendChild` on a region's container, always
 * in ascending `order`, so the container's actual child list is always the
 * sorted list. Moving an already-attached node with `appendChild` repositions
 * it in place — it is not recreated, so it never loses focus, input state or
 * an open popover.
 */
interface HudItemRecord {
  order: number;
  node: HTMLDivElement;
}

const regionItems = new Map<HudRegionName, Map<string, HudItemRecord>>();

/** Re-append every registered item of `region`, ascending by `order`, so the
 *  container's DOM child order matches the sort exactly. Array.prototype.sort
 *  is stable, so ties keep registration order. No-op if the region's
 *  container isn't mounted yet — items reconcile once it is (`HudItem`
 *  re-registers when `getHudRegionNode` transitions from `null`). */
function reorderRegion(region: HudRegionName): void {
  const container = nodes.get(region);
  const items = regionItems.get(region);
  if (!container || !items || items.size === 0) return;
  const sorted = Array.from(items.values()).sort((a, b) => a.order - b.order);
  for (const item of sorted) container.appendChild(item.node);
}

/** Register `node` (already carrying its rendered content via a portal) as
 *  region `region`'s item `id` at `order`, and reconcile that region's DOM
 *  order immediately. Upserts: re-registering an existing `id` updates its
 *  `order` and re-sorts. */
export function registerHudItem(region: HudRegionName, id: string, order: number, node: HTMLDivElement): void {
  let items = regionItems.get(region);
  if (!items) {
    items = new Map();
    regionItems.set(region, items);
  }
  items.set(id, { order, node });
  reorderRegion(region);
}

/** Unregister item `id` from `region` and detach its node from the DOM
 *  (`Node.remove()` is a no-op if it was never attached, e.g. the region's
 *  container never mounted). */
export function unregisterHudItem(region: HudRegionName, id: string): void {
  const items = regionItems.get(region);
  const record = items?.get(id);
  if (!items || !record) return;
  items.delete(id);
  record.node.remove();
}
