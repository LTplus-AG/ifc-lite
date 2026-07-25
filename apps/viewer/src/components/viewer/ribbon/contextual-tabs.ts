/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Contextual ribbon tabs — which tab opens itself, and when.
 *
 * The CAD precedent (Revit's "Modify | Walls", Office's contextual tabs) is
 * that the ribbon follows what you are working on and gives the tab back
 * when that work ends. Copied here with three hard rules, because a toolbar
 * that moves under the cursor is worse than one that never moves:
 *
 *  1. Only a RISING EDGE of a real context switches a tab. Continuous state
 *     ("something is selected") never re-fires, so clicking element after
 *     element never re-flips anything.
 *  2. Auto-switching only ever steals a NEUTRAL tab (Home, File). A user
 *     sitting on View, Analyze or Author is mid-task and is left alone.
 *  3. Everything is returnable: the tab we replaced is remembered and
 *     restored when the context drops. The moment the user picks a tab by
 *     hand that memory is dropped (the caller detects the divergence), so
 *     an explicit choice is never undone behind their back.
 *
 * This module is pure so the whole policy is unit-testable without a DOM;
 * `useRibbonContextualTab` owns the edges and the store writes.
 */

import type { RibbonTabId } from '@/store';

/** The working context the ribbon reacts to. */
export interface RibbonContext {
  /** At least one model is in the scene. */
  hasModel: boolean;
  /** At least one entity is selected. */
  hasSelection: boolean;
  /** Global edit mode is on. */
  editEnabled: boolean;
}

/** What we opened on the user's behalf, and where to put them back. */
export interface RibbonTabMemory {
  /** Tab this module opened; null when the current tab is the user's own. */
  autoOpened: RibbonTabId | null;
  /** Tab that was showing before we took over. */
  returnTo: RibbonTabId | null;
}

export interface RibbonTabDecision {
  tab: RibbonTabId;
  memory: RibbonTabMemory;
}

export const NO_TAB_MEMORY: RibbonTabMemory = { autoOpened: null, returnTo: null };

/**
 * Tabs an auto-switch may replace. Home is the everyday landing and File is
 * a transient errand; the other three mean the user went somewhere on
 * purpose and expects to stay there.
 */
const NEUTRAL_TABS: readonly RibbonTabId[] = ['home', 'file'];

function takeOver(tab: RibbonTabId, from: RibbonTabId): RibbonTabDecision {
  return { tab, memory: { autoOpened: tab, returnTo: from } };
}

/** Hand the tab back if (and only if) we are the one holding it. */
function handBack(
  expected: RibbonTabId,
  tab: RibbonTabId,
  memory: RibbonTabMemory,
): RibbonTabDecision | null {
  if (memory.autoOpened !== expected || tab !== expected || !memory.returnTo) return null;
  return { tab: memory.returnTo, memory: NO_TAB_MEMORY };
}

/**
 * Decide the next ribbon tab for a context change.
 *
 * @param prev Context at the previous evaluation, or null on the first pass
 *   (mount, or the user switching over from the classic toolbar).
 * @param next Context now.
 * @param tab  Tab currently showing.
 * @param memory What we opened last, and the tab to return.
 * @returns The tab + memory to apply, or null to leave the ribbon alone.
 */
export function decideRibbonTab(
  prev: RibbonContext | null,
  next: RibbonContext,
  tab: RibbonTabId,
  memory: RibbonTabMemory,
): RibbonTabDecision | null {
  // First pass: pick the landing tab. With no model loaded, every tab but
  // File is disabled buttons — so land on the one that can actually do
  // something. Only ever moves off the default tab, never off a choice the
  // user already made this session.
  if (!prev) {
    if (!next.hasModel && tab === 'home') return takeOver('file', 'home');
    return null;
  }

  // Model set: an empty scene is the File context; the first model that
  // lands ends it. Both directions clear the memory - a load is a big
  // enough state change that an older "return to" is stale.
  if (!prev.hasModel && next.hasModel) {
    return tab === 'file' ? { tab: 'home', memory: NO_TAB_MEMORY } : null;
  }
  if (prev.hasModel && !next.hasModel) {
    return tab === 'file' ? null : { tab: 'file', memory: NO_TAB_MEMORY };
  }

  // Edit mode outranks selection: while authoring, the Author tab is the
  // context even with something selected.
  if (!prev.editEnabled && next.editEnabled) {
    return NEUTRAL_TABS.includes(tab) ? takeOver('author', tab) : null;
  }
  if (prev.editEnabled && !next.editEnabled) {
    return handBack('author', tab, memory);
  }

  // Selection: the Elements tab is where Isolate / Hide / Focus / Copy guid
  // live, so a fresh selection is exactly when it is worth showing.
  if (!prev.hasSelection && next.hasSelection && !next.editEnabled) {
    return NEUTRAL_TABS.includes(tab) ? takeOver('elements', tab) : null;
  }
  if (prev.hasSelection && !next.hasSelection) {
    return handBack('elements', tab, memory);
  }

  return null;
}
