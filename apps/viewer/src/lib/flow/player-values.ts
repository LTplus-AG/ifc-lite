/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Flavor persistence" for the Player (#5167 Phase 4.1): the last raw form
 * values a graph's Player was run with, keyed by graph id, in
 * `localStorage` — the same store `persistence.ts` keeps saved graphs and
 * tracking sidecars in, so a failed write (disabled storage, quota) is
 * swallowed rather than crashing the panel, same as `BrowserTrackingStore`.
 */

const PREFIX = 'ifc-lite-flow-player:';
const MAX_BYTES = 50_000;

function isRawValues(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Last raw form values entered for this graph, or `{}` when none are stored. */
export function loadPlayerValues(graphId: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(PREFIX + graphId);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return isRawValues(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Persists the raw form values for this graph. A failed write is not fatal. */
export function savePlayerValues(graphId: string, values: Readonly<Record<string, unknown>>): void {
  try {
    const text = JSON.stringify(values);
    if (text.length > MAX_BYTES) return;
    localStorage.setItem(PREFIX + graphId, text);
  } catch {
    // Storage disabled or full: the next session falls back to the graph's
    // own defaults, same as a fresh browser profile.
  }
}

export function clearPlayerValues(graphId: string): void {
  try {
    localStorage.removeItem(PREFIX + graphId);
  } catch {
    // Nothing to do: a removal that cannot land leaves stale values behind,
    // not a crash.
  }
}
