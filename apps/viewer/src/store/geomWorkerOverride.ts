/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { clearStickyQueryOverride } from './stickyQueryOverride.js';

/** localStorage key for the geometry-worker-count A/B override. */
export const GEOM_WORKERS_STORAGE_KEY = 'ifc-lite-geom-workers';

function parseWorkerCount(value: string | null): number | undefined {
  const count = Number.parseInt(value ?? '', 10);
  return Number.isFinite(count) && count >= 1 && count <= 16 ? count : undefined;
}

/** Read the effective value for Settings without writing during React render. */
export function peekGeomWorkerOverride(): number | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const param = new URLSearchParams(window.location.search).get('geomWorkers');
    if (param === '0' || param === 'auto') return undefined;
    return parseWorkerCount(param) ?? parseWorkerCount(localStorage.getItem(GEOM_WORKERS_STORAGE_KEY));
  } catch (error) {
    console.warn('[geom-workers] override read failed; using heuristic', error);
    return undefined;
  }
}

/**
 * Resolve an explicit worker count, or let the engine use its cores/memory
 * heuristic. `?geomWorkers=N` persists across reloads; `0` and `auto` clear it.
 */
export function getGeomWorkerOverride(): number | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const param = new URLSearchParams(window.location.search).get('geomWorkers');
    if (param != null) {
      if (param === '0' || param === 'auto') {
        localStorage.removeItem(GEOM_WORKERS_STORAGE_KEY);
        return undefined;
      }
      const n = parseWorkerCount(param);
      if (n !== undefined) {
        localStorage.setItem(GEOM_WORKERS_STORAGE_KEY, String(n));
        return n;
      }
    }
    return parseWorkerCount(localStorage.getItem(GEOM_WORKERS_STORAGE_KEY));
  } catch (error) {
    console.warn('[geom-workers] override read failed; using heuristic', error);
  }
  return undefined;
}

/**
 * The override to hand the geometry engine. `?geomWorkers=N` in THIS page's
 * URL is a fresh, deliberate request and may spend the memory budget's
 * headroom (`beyondBudget`, still clamped to the whole device). A value only
 * remembered in localStorage may be months old and set for another model, so
 * it stays a plain number and the engine's memory budget clips it, as it always did.
 */
export function getGeomWorkerOverrideRequest(): number | { count: number; beyondBudget: true } | undefined {
  const count = getGeomWorkerOverride();
  if (count === undefined || typeof window === 'undefined') return count;
  try {
    const fromUrl = parseWorkerCount(new URLSearchParams(window.location.search).get('geomWorkers'));
    return fromUrl === count ? { count, beyondBudget: true } : count;
  } catch (error) {
    console.warn('[geom-workers] override URL read failed; keeping the budget', error);
    return count;
  }
}

/** Restore automatic worker selection, including on the originating URL. */
export function clearGeomWorkerOverride(): void {
  clearStickyQueryOverride(GEOM_WORKERS_STORAGE_KEY, 'geomWorkers');
}
