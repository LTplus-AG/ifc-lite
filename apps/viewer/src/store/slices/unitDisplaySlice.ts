/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Display-unit converter overrides (issue #1573 proposal 2) - a per-unit-KIND
 * (unit-type token, e.g. "VOLUMETRICFLOWRATEUNIT") choice of which curated
 * alternative to render values in (see `lib/units/alternatives.ts`).
 *
 * This is DISPLAY-ONLY and NON-DESTRUCTIVE: it never mutates the model or any
 * stored/mutation value, only the number + symbol shown in property/quantity
 * cards (`lib/units/display.ts`'s `resolveMeasureDisplay`/
 * `resolveQuantityDisplay`) and, where wired, list/schedule exports.
 *
 * Persists across sessions via localStorage (scoped per browser, workspace-
 * wide - not per file), mirroring `annotationsSlice.ts`'s load/save pattern.
 */

import { type StateCreator } from 'zustand';

const STORAGE_KEY = 'ifc-lite:unit-display-overrides';

export interface UnitDisplaySlice {
  /** unitType (e.g. "LENGTHUNIT") -> chosen UnitOption id (e.g. "mm"). Absent
   *  keys render in the file's declared unit (no override). */
  unitDisplayOverrides: Record<string, string>;

  /** Set (or, with `optionId: null`, clear) the display-unit override for a
   *  unit-type token. */
  setUnitDisplayOverride: (unitType: string, optionId: string | null) => void;
  /** Clear every override, reverting every value to the file's declared unit. */
  resetUnitDisplayOverrides: () => void;
}

// ── Persistence ──────────────────────────────────────────────────────

function isValidOverrides(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v as Record<string, unknown>).every(
    ([key, val]) => typeof key === 'string' && typeof val === 'string',
  );
}

function loadFromStorage(): Record<string, string> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!isValidOverrides(parsed)) {
      // eslint-disable-next-line no-console
      console.warn(`[unitDisplay] discarding malformed entry from ${STORAGE_KEY}`, parsed);
      return {};
    }
    return parsed;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[unitDisplay] failed to load from ${STORAGE_KEY}`, err);
    return {};
  }
}

function saveToStorage(overrides: Record<string, string>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch (err) {
    // Quota exceeded / private mode - overrides stay in memory but the
    // warning makes the failure debuggable.
    // eslint-disable-next-line no-console
    console.warn(`[unitDisplay] failed to persist to ${STORAGE_KEY}`, err);
  }
}

// ── Slice ────────────────────────────────────────────────────────────

export const createUnitDisplaySlice: StateCreator<UnitDisplaySlice, [], [], UnitDisplaySlice> = (set) => ({
  unitDisplayOverrides: loadFromStorage(),

  setUnitDisplayOverride: (unitType, optionId) => {
    set((state) => {
      const next = { ...state.unitDisplayOverrides };
      if (optionId === null) delete next[unitType];
      else next[unitType] = optionId;
      saveToStorage(next);
      return { unitDisplayOverrides: next };
    });
  },

  resetUnitDisplayOverrides: () => {
    saveToStorage({});
    set({ unitDisplayOverrides: {} });
  },
});
