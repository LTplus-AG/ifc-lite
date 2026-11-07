/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which activity-rail icons fit the rail's height, and which go into its
 * overflow menu (#8802 R1). The rail used to scroll silently, so a bottom
 * dock cut icons and group captions in half with no hint that more existed.
 *
 * Pure layout arithmetic over the rail's fixed row sizes (`ActivityBar`'s
 * classes), so it is testable without a layout engine. A tour anchor takes
 * priority over the active panel, but both yield to the overflow control when
 * the window cannot fit them beside it.
 */

/** Row pitch of one icon: `h-9` plus the list's `gap-0.5`. */
export const RAIL_ITEM_PX = 38;
/** A group divider: `h-px` + `my-1` plus the list's `gap-0.5`. */
export const RAIL_DIVIDER_PX = 11;
/** The icon list's own `py-1.5`, plus the gap after the first group's zero-height heading. */
export const RAIL_PADDING_PX = 14;

export interface RailEntry<Id extends string> {
  id: Id;
  group: string;
}

export interface RailFit<Id extends string> {
  visible: Id[];
  overflow: Id[];
}

/** Height a run of entries takes, dividers between groups included. */
export function railHeight<Id extends string>(entries: readonly RailEntry<Id>[]): number {
  let height = RAIL_PADDING_PX;
  entries.forEach((entry, index) => {
    if (index > 0 && entry.group !== entries[index - 1].group) height += RAIL_DIVIDER_PX;
    height += RAIL_ITEM_PX;
  });
  return height;
}

/**
 * Split `entries` (rail order) into the icons that fit `availablePx` and the
 * rest. An unknown height (0, e.g. before the first measurement or with no
 * layout engine) keeps every icon visible, matching the old scrolling rail.
 *
 * `pinned` icons take priority in array order (tour anchor first, then active
 * panel). Pins past the fold replace unpinned icons; when even the pins do
 * not fit beside More, the lowest-priority pin yields first.
 *
 * `moreRequired` says the overflow button will be shown whatever fits, as it
 * is when panels wait in it for a model (`foldModelPanels`). Its row is then
 * reserved before deciding what fits: measured without it, a rail that only
 * just fits kept every icon and pushed More past the rail's clipped bottom
 * edge, where the panels waiting in it could not be reached (#8802 R6).
 */
export function fitRail<Id extends string>(
  entries: readonly RailEntry<Id>[],
  availablePx: number,
  pinned: readonly (Id | null | undefined)[] = [],
  { moreRequired = false }: { moreRequired?: boolean } = {},
): RailFit<Id> {
  const all = entries.map((entry) => entry.id);
  // Reserve one row for the overflow button itself.
  const budget = availablePx - RAIL_ITEM_PX;
  const room = moreRequired ? budget : availablePx;
  if (availablePx <= 0 || railHeight(entries) <= room) return { visible: all, overflow: [] };

  const keep = new Set(pinned.filter((id): id is Id => !!id));
  let count = 0;
  while (count < entries.length && railHeight(entries.slice(0, count + 1)) <= budget) count += 1;
  const shown = new Set(entries.slice(0, Math.max(1, count)).map((entry) => entry.id));

  // Pinned icons past the fold displace the last unpinned shown ones; the
  // run is then trimmed (unpinned from the end) until it fits again, since a
  // pinned icon from another group can add a divider.
  const run = () => entries.filter((entry) => shown.has(entry.id));
  const dropLastUnpinned = () => {
    const victim = [...run()].reverse().find((entry) => !keep.has(entry.id));
    if (!victim) return false;
    shown.delete(victim.id);
    return true;
  };
  for (const id of keep) {
    if (shown.has(id) || !all.includes(id)) continue;
    dropLastUnpinned();
    shown.add(id);
  }
  while (shown.size > 0 && railHeight(run()) > budget) {
    if (dropLastUnpinned()) continue;
    // Tour anchor comes first in `pinned`; shed the active panel first
    // (its pane stays open), then the tour anchor if only More fits.
    const victim = [...keep].reverse().find((id) => shown.has(id));
    if (!victim) break;
    shown.delete(victim);
  }

  return { visible: all.filter((id) => shown.has(id)), overflow: all.filter((id) => !shown.has(id)) };
}

/**
 * The empty start screen's rail (#8802 R6): panels that `waits` (they show
 * only "open a model first" without one) leave the rail for the overflow
 * menu, after the icons that work now, so twenty quiet icons do not
 * outnumber the few ways in. Order within each half is rail order.
 *
 * A `pinned` id stays on the rail whatever it is: the current tour step's
 * anchor must be there for the tour to point at, and the open panel keeps its
 * active mark.
 */
export function foldModelPanels<Id extends string>(
  entries: readonly RailEntry<Id>[],
  waits: (id: Id) => boolean,
  pinned: readonly (Id | null | undefined)[] = [],
): { rail: RailEntry<Id>[]; waiting: Id[] } {
  const keep = new Set(pinned.filter((id): id is Id => !!id));
  const rail: RailEntry<Id>[] = [];
  const waiting: Id[] = [];
  for (const entry of entries) {
    if (waits(entry.id) && !keep.has(entry.id)) waiting.push(entry.id);
    else rail.push(entry);
  }
  return { rail, waiting };
}

/**
 * The rail as `ActivityBar` lays it out, in one place:
 *
 * - **Pins**: `anchors` (the current tour step's anchor first, then the
 *   right-pane panel) and every panel `isOpen` reports open in any slot: the
 *   left slot, the right pane's primary and split halves, the bottom strip, a
 *   floating or popped-out window. An open panel's icon carries its open mark,
 *   so it is never folded away or pushed into More while there is room for it.
 *   Pins yield only when even they do not fit beside More, lowest priority
 *   (last) first, as `fitRail` documents; More then names them open.
 * - **Fold**: on the empty start screen, `waits` names the panels that need a
 *   model; unless pinned they wait in More (`foldModelPanels`). `null` folds
 *   none (a model is loaded).
 * - **Fit**: the rest is fitted to the height with More's row reserved
 *   whenever something waits in it, and the overflow is listed in rail order
 *   so the menu's group headings stay one run each.
 */
export function layoutRail<Id extends string>(
  entries: readonly RailEntry<Id>[],
  availablePx: number,
  { anchors = [], isOpen = () => false, waits = null }: {
    anchors?: readonly (Id | null | undefined)[];
    isOpen?: (id: Id) => boolean;
    waits?: ((id: Id) => boolean) | null;
  } = {},
): RailFit<Id> & { waiting: Id[] } {
  const pinned = [...new Set([...anchors.filter((id): id is Id => !!id), ...entries.map((e) => e.id).filter(isOpen)])];
  const { rail, waiting } = waits ? foldModelPanels(entries, waits, pinned) : { rail: [...entries], waiting: [] as Id[] };
  const fit = fitRail(rail, availablePx, pinned, { moreRequired: waiting.length > 0 });
  const over = new Set([...fit.overflow, ...waiting]);
  return { visible: fit.visible, overflow: entries.map((e) => e.id).filter((id) => over.has(id)), waiting };
}
