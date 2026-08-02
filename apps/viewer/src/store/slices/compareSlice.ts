/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model-comparison panel state (issue #924). Holds the panel's UI state, the
 * A/B model selection, the data-vs-geometry scope, and the last `@ifc-lite/diff`
 * result. The orchestration (building per-entity fingerprints from each model's
 * `IfcDataStore` + geometry hashes, running `diffModels`, applying the 3D
 * colour/visibility overlay) lives in the `useCompare` hook — this slice is
 * deliberately dumb, mirroring `clashSlice` + `useClash`.
 */

import type { StateCreator } from 'zustand';
import type { DiffScope, ModelDiff } from '@ifc-lite/diff';
import type { CompareRef } from '@/lib/compare/buildFingerprints';

/** A completed comparison: the engine result plus the A/B context it ran on. */
export interface CompareResult {
  /** Federation model id chosen as the base (version A). */
  baseModelId: string;
  /** Federation model id chosen as the head (version B). */
  headModelId: string;
  /** Display name of the base model. */
  baseName: string;
  /** Display name of the head model. */
  headName: string;
  /** The scope the diff was computed with. */
  scope: DiffScope;
  /** True when a compared model carries no geometry hashes (loaded outside the
   *  WASM mesh path), so geometry-scope changes can't be detected. */
  geometryUnavailable: boolean;
  /**
   * Federation global ids of meshed entities whose class is on the blacklist
   * ({@link CompareSlice.compareExcludedTypes}) - dropped from the diff, so the
   * overlay hides them in 3D rather than leaving their meshes drawn at full
   * colour amid the ghosted compare scene (issue #1470). Both A and B copies.
   */
  excludedHiddenIds: Set<number>;
  /** The engine output — entries keyed by GlobalId, with per-entity refs. */
  diff: ModelDiff<CompareRef>;
}

/** localStorage key for the cross-file compare blacklist (issue #1470). */
const EXCLUDED_TYPES_STORAGE_KEY = 'ifc-lite:compare-excluded-types-v1';

/** Case-insensitive de-dup while preserving the first-seen display casing (IFC
 *  PascalCase from the store, e.g. `IfcOpeningElement`). Trims and drops blanks. */
function dedupeTypes(names: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const canon = trimmed.toUpperCase();
    if (seen.has(canon)) continue;
    seen.add(canon);
    out.push(trimmed);
  }
  return out;
}

function loadPersistedExcludedTypes(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(EXCLUDED_TYPES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? dedupeTypes(parsed) : [];
  } catch (error) {
    console.warn('[compare] ignoring malformed persisted blacklist:', error);
    return [];
  }
}

function persistExcludedTypes(types: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(EXCLUDED_TYPES_STORAGE_KEY, JSON.stringify(types));
  } catch (error) {
    // Quota / private mode - the blacklist just won't persist this session.
    console.warn('[compare] failed to persist blacklist:', error);
  }
}

export interface CompareSlice {
  comparePanelVisible: boolean;
  /** Selected base (A) / head (B) federation model ids. */
  compareBaseModelId: string | null;
  compareHeadModelId: string | null;
  /** What counts as a change: data, geometry, or both. */
  compareScope: DiffScope;
  /**
   * IFC classes the user has blacklisted - never considered as changes in the
   * comparison (issue #1470). Persisted across files/sessions to localStorage.
   * Display casing is preserved; matching against entities is case-insensitive.
   */
  compareExcludedTypes: string[];
  /** Whether unchanged elements are drawn (ghosted) or hidden. */
  compareShowUnchanged: boolean;
  /** Last comparison result (null when idle / not yet run). */
  compareResult: CompareResult | null;
  /**
   * Monotonic count of COMPLETED comparisons (a fresh run or a scope re-diff).
   * Bumped by `useCompare` right after each successful non-null
   * `setCompareResult` - never on error paths and never reset - so a consumer
   * needing "a comparison completed since X" (e.g. the compare tour's run
   * gate) can baseline-compare a number instead of reference-diffing
   * `compareResult`. Mirrors `clashRunSeq`.
   */
  compareRunSeq: number;
  compareRunning: boolean;
  compareError: string | null;
  /** GlobalId of the entry focused in the list (for highlight). */
  compareSelectedKey: string | null;

  setComparePanelVisible: (visible: boolean) => void;
  toggleComparePanel: () => void;
  setCompareBaseModelId: (id: string | null) => void;
  setCompareHeadModelId: (id: string | null) => void;
  setCompareScope: (scope: DiffScope) => void;
  /** Replace the whole blacklist (de-duped + persisted). */
  setCompareExcludedTypes: (types: string[]) => void;
  /** Add one IFC class to the blacklist (no-op if already present). */
  addCompareExcludedType: (type: string) => void;
  /** Remove one IFC class from the blacklist (case-insensitive). */
  removeCompareExcludedType: (type: string) => void;
  /** Empty the blacklist. */
  clearCompareExcludedTypes: () => void;
  setCompareShowUnchanged: (show: boolean) => void;
  setCompareResult: (result: CompareResult | null) => void;
  bumpCompareRunSeq: () => void;
  setCompareRunning: (running: boolean) => void;
  setCompareError: (error: string | null) => void;
  setCompareSelectedKey: (key: string | null) => void;
  /** Clear the run result + selection; keeps the A/B + scope choices. */
  clearCompare: () => void;
}

export const createCompareSlice: StateCreator<CompareSlice, [], [], CompareSlice> = (set) => ({
  comparePanelVisible: false,
  compareBaseModelId: null,
  compareHeadModelId: null,
  compareScope: 'both',
  compareExcludedTypes: loadPersistedExcludedTypes(),
  compareShowUnchanged: false,
  compareResult: null,
  compareRunSeq: 0,
  compareRunning: false,
  compareError: null,
  compareSelectedKey: null,

  setComparePanelVisible: (comparePanelVisible) => set({ comparePanelVisible }),
  toggleComparePanel: () => set((s) => ({ comparePanelVisible: !s.comparePanelVisible })),
  setCompareBaseModelId: (compareBaseModelId) => set({ compareBaseModelId }),
  setCompareHeadModelId: (compareHeadModelId) => set({ compareHeadModelId }),
  setCompareScope: (compareScope) => set({ compareScope }),

  setCompareExcludedTypes: (types) => {
    const compareExcludedTypes = dedupeTypes(types);
    persistExcludedTypes(compareExcludedTypes);
    set({ compareExcludedTypes });
  },
  addCompareExcludedType: (type) =>
    set((s) => {
      const compareExcludedTypes = dedupeTypes([...s.compareExcludedTypes, type]);
      // dedupeTypes trims/skips blanks, so a no-op add (blank or already present)
      // leaves the length unchanged - skip the persist + state write entirely.
      if (compareExcludedTypes.length === s.compareExcludedTypes.length) return s;
      persistExcludedTypes(compareExcludedTypes);
      return { compareExcludedTypes };
    }),
  removeCompareExcludedType: (type) =>
    set((s) => {
      const canon = type.trim().toUpperCase();
      const compareExcludedTypes = s.compareExcludedTypes.filter(
        (t) => t.toUpperCase() !== canon,
      );
      if (compareExcludedTypes.length === s.compareExcludedTypes.length) return s;
      persistExcludedTypes(compareExcludedTypes);
      return { compareExcludedTypes };
    }),
  clearCompareExcludedTypes: () => {
    persistExcludedTypes([]);
    set({ compareExcludedTypes: [] });
  },

  setCompareShowUnchanged: (compareShowUnchanged) => set({ compareShowUnchanged }),
  setCompareResult: (compareResult) => set({ compareResult }),
  bumpCompareRunSeq: () => set((s) => ({ compareRunSeq: s.compareRunSeq + 1 })),
  setCompareRunning: (compareRunning) => set({ compareRunning }),
  setCompareError: (compareError) => set({ compareError }),
  setCompareSelectedKey: (compareSelectedKey) => set({ compareSelectedKey }),

  clearCompare: () =>
    set({
      compareResult: null,
      compareRunning: false,
      compareError: null,
      compareSelectedKey: null,
    }),
});
