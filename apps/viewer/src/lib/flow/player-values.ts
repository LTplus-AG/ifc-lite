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

/** Runtime resources have no portable meaning and must never reach localStorage. */
function hasRuntimeResource(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let budget = 10_000;
  while (pending.length) {
    if (--budget < 0) return true;
    const current = pending.pop();
    if (typeof current === 'string' && current.startsWith('flow-resource:')) return true;
    if (typeof Blob !== 'undefined' && current instanceof Blob) return true;
    if (current && typeof current === 'object') {
      if (seen.has(current)) return true;
      seen.add(current);
      pending.push(...Object.values(current));
    }
  }
  return false;
}

/** Last raw form values entered for this graph, or `{}` when none are stored. */
export function loadPlayerValues(graphId: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(PREFIX + graphId);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return isRawValues(parsed) ? parsed : {};
  } catch (error) {
    console.warn('[flow] could not restore Player values', error);
    return {};
  }
}

/** Persists the raw form values for this graph. A failed write is not fatal. */
export function savePlayerValues(graphId: string, values: Readonly<Record<string, unknown>>): string | null {
  try {
    const persistable = Object.fromEntries(Object.entries(values).filter(([, value]) => !hasRuntimeResource(value)));
    const text = JSON.stringify(persistable);
    if (text.length > MAX_BYTES) return 'Player values exceed the storage limit.';
    localStorage.setItem(PREFIX + graphId, text);
    return null;
  } catch (error) {
    console.warn('[flow] could not save Player values', error);
    return error instanceof Error ? error.message : String(error);
  }
}

export function clearPlayerValues(graphId: string): void {
  try {
    localStorage.removeItem(PREFIX + graphId);
  } catch (error) {
    console.warn('[flow] could not clear Player values', error);
  }
}

/**
 * Drops the stored values of every graph whose id starts with `idPrefix`
 * (an uninstalled extension's `ext:<id>:` graphs, #5634), mirroring
 * `BrowserTrackingStore.clearByIdPrefix`.
 */
export function clearPlayerValuesByIdPrefix(idPrefix: string): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX + idPrefix)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch (error) {
    console.warn('[flow] could not clear extension Player values', error);
  }
}
