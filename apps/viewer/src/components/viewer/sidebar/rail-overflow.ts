/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Which activity-rail icons fit the rail's height, and which go into its
 * overflow menu (#8802 R1). The rail used to scroll silently, so a bottom
 * dock cut icons and group captions in half with no hint that more existed.
 *
 * Pure layout arithmetic over the rail's fixed row sizes (`ActivityBar`'s
 * classes), so it is testable without a layout engine. The active panel takes
 * priority over a tour anchor, but both yield to the overflow control when
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
 * `pinned` icons take priority in array order (active panel first, then tour
 * anchor). Pins past the fold replace unpinned icons; when even the pins do
 * not fit beside More, the lowest-priority pin yields first.
 */
export function fitRail<Id extends string>(
  entries: readonly RailEntry<Id>[],
  availablePx: number,
  pinned: readonly (Id | null | undefined)[] = [],
): RailFit<Id> {
  const all = entries.map((entry) => entry.id);
  if (availablePx <= 0 || railHeight(entries) <= availablePx) return { visible: all, overflow: [] };

  // Reserve one row for the overflow button itself.
  const budget = availablePx - RAIL_ITEM_PX;
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
    // Active comes first in `pinned`; shed the tour target before the active
    // panel, and finally the active panel itself if only More fits.
    const victim = [...keep].reverse().find((id) => shown.has(id));
    if (!victim) break;
    shown.delete(victim);
  }

  return { visible: all.filter((id) => shown.has(id)), overflow: all.filter((id) => !shown.has(id)) };
}
