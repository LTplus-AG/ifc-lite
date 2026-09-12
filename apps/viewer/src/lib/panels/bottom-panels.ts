/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bottom strip's panels, as ONE table.
 *
 * Script / Schedule / Lists dock in the bottom strip, mutually exclusive,
 * each behind its own store flag (`scriptPanelVisible` and so on — the flags
 * predate the registry and other code reads them directly). Six places used
 * to spell that trio out by hand: three store actions, the layout's ternary,
 * the mobile sheet's precedence and the tour snapshot — and two of them
 * disagreed on the order in which a doubly-set flag wins. Adding a fourth
 * bottom panel meant finding all six, three of them at their module-size
 * budget. Now the id list, the flag names and the "which one is showing"
 * rule live here, and every reader derives from them (#3944).
 *
 * Order is precedence: when more than one flag is somehow on (the flag
 * setters are independent), the FIRST one here is what the strip shows.
 */

/** Bottom-strip panel ids, in display precedence. Append only. */
export const BOTTOM_PANEL_IDS = ['gantt', 'script', 'lists', 'charts'] as const;

export type BottomPanelId = (typeof BOTTOM_PANEL_IDS)[number];

/** The store flag that says a bottom panel is docked open. */
export const BOTTOM_PANEL_FLAG = {
  gantt: 'ganttPanelVisible',
  script: 'scriptPanelVisible',
  lists: 'listPanelVisible',
  charts: 'chartPanelVisible',
} as const satisfies Record<BottomPanelId, string>;

export type BottomPanelFlag = (typeof BOTTOM_PANEL_FLAG)[BottomPanelId];

/** The slice of store state the bottom strip reads. */
export type BottomPanelFlags = Record<BottomPanelFlag, boolean>;

export function isBottomPanel(id: string): id is BottomPanelId {
  return (BOTTOM_PANEL_IDS as readonly string[]).includes(id);
}

/**
 * The flag patch that docks exactly `active` open (or, with `null`, closes
 * the whole strip). Always writes every flag, so a stray second flag cannot
 * survive a switch.
 */
export function bottomPanelFlags(active: BottomPanelId | null): BottomPanelFlags {
  const patch = {} as BottomPanelFlags;
  for (const id of BOTTOM_PANEL_IDS) patch[BOTTOM_PANEL_FLAG[id]] = id === active;
  return patch;
}

/** Which bottom panel the flags say is docked open — the first in precedence. */
export function activeBottomPanel(flags: BottomPanelFlags): BottomPanelId | null {
  for (const id of BOTTOM_PANEL_IDS) if (flags[BOTTOM_PANEL_FLAG[id]]) return id;
  return null;
}

/** Whether the flag for one bottom panel is on. */
export function isBottomPanelOpen(flags: BottomPanelFlags, id: BottomPanelId): boolean {
  return flags[BOTTOM_PANEL_FLAG[id]];
}
