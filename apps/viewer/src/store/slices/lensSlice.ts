/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lens state slice
 *
 * Rule-based 3D filtering and coloring system.
 * Types, constants, presets, and evaluation logic live in @ifc-lite/lens.
 * This slice manages Zustand state, CRUD actions, and localStorage persistence.
 */

import type { StateCreator } from 'zustand';
import type { Lens, LensRule, LensCriteria, AutoColorSpec, AutoColorLegendEntry, DiscoveredLensData } from '@ifc-lite/lens';
import { BUILTIN_LENSES } from '@ifc-lite/lens';
import { duplicateLensConfig, mergeImportedLenses, reserveUniqueId } from '@/components/viewer/lens-editor-utils';
import { saveJson, type SaveResult } from '@/lib/storage/save-result';

// Re-export types so existing consumer imports from this file still work
export type { Lens, LensRule, LensCriteria, AutoColorSpec, AutoColorLegendEntry, DiscoveredLensData };
export type { SaveResult };

// Re-export constants for consumers that import from this file
export {
  COMMON_IFC_CLASSES, COMMON_IFC_TYPES, LENS_PALETTE,
  LENS_CRITERIA_TYPES, AUTO_COLOR_SOURCES, ENTITY_ATTRIBUTE_NAMES,
} from '@ifc-lite/lens';

/** localStorage key for persisting custom lenses */
const STORAGE_KEY = 'ifc-lite-custom-lenses';

/** Ephemeral lens ID created when coloring from list column headers */
export const AUTO_COLOR_FROM_LIST_ID = 'auto-color-from-list';

/** Built-in lens IDs — used to detect overrides */
const BUILTIN_IDS = new Set(BUILTIN_LENSES.map(l => l.id));

/**
 * Load saved lenses from localStorage.
 * Returns both custom lenses and built-in overrides (user edits to builtin lenses).
 * Built-in overrides replace the default builtin when merging in initial state.
 */
function loadSavedLenses(): { custom: Lens[]; builtinOverrides: Map<string, Lens> } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { custom: [], builtinOverrides: new Map() };
    const parsed = JSON.parse(raw) as Lens[];
    if (!Array.isArray(parsed)) return { custom: [], builtinOverrides: new Map() };
    const valid = parsed.filter(l => l.id && l.name && Array.isArray(l.rules));
    const builtinOverrides = new Map<string, Lens>();
    const custom: Lens[] = [];
    for (const l of valid) {
      if (BUILTIN_IDS.has(l.id)) {
        builtinOverrides.set(l.id, { ...l, builtin: true });
      } else {
        custom.push(l);
      }
    }
    return { custom, builtinOverrides };
  } catch {
    return { custom: [], builtinOverrides: new Map() };
  }
}

/** What the save messages call the thing being persisted. */
const SAVE_SUBJECT = 'lens changes';

/**
 * Persist lenses to localStorage.
 * Saves custom lenses + any built-in lenses the user has edited (overrides).
 *
 * Returns a `SaveResult` rather than swallowing the failure: every CRUD action
 * below commits to the store only when the write actually landed, so the panel
 * can never show a lens that will be gone on reload.
 */
function saveLenses(lenses: Lens[]): SaveResult {
  let toStore: Lens[];
  try {
    // Save non-builtin custom lenses, but never the ephemeral
    // "color from list column" lens — it is intentionally transient and must
    // not be restored as a stray "Color by …" lens on reload.
    const custom = lenses.filter(l => !l.builtin && l.id !== AUTO_COLOR_FROM_LIST_ID);
    // Also save built-in lenses that differ from their defaults (user overrides)
    const builtinOverrides = lenses.filter(l => {
      if (!l.builtin) return false;
      const original = BUILTIN_LENSES.find(b => b.id === l.id);
      if (!original) return false;
      // Has the user changed the name, rules, or auto-color spec? autoColor must
      // be part of this check or an autoColor-only edit to an auto-color builtin
      // (rules: []) imported via the JSON round-trip would be dropped on reload.
      return l.name !== original.name ||
        JSON.stringify(l.rules) !== JSON.stringify(original.rules) ||
        JSON.stringify(l.autoColor) !== JSON.stringify(original.autoColor);
    });
    toStore = [...custom, ...builtinOverrides];
  } catch {
    // The override check stringifies rules/autoColor, so a non-serializable
    // lens fails here rather than in saveJson. Same class of failure.
    return { ok: false, reason: 'serialize', message: `Could not save ${SAVE_SUBJECT}.` };
  }
  return saveJson(STORAGE_KEY, toStore, SAVE_SUBJECT);
}

/** Build initial lens list: builtins (with overrides applied) + custom */
function buildInitialLenses(): Lens[] {
  const { custom, builtinOverrides } = loadSavedLenses();
  const builtins = BUILTIN_LENSES.map(l =>
    builtinOverrides.has(l.id) ? builtinOverrides.get(l.id)! : { ...l },
  );
  return [...builtins, ...custom];
}

/** `duplicateLens` carries the new copy alongside the save outcome. */
export type DuplicateLensResult =
  | { ok: true; lens: Lens | null }
  | Extract<SaveResult, { ok: false }>;

export interface LensSlice {
  // State
  savedLenses: Lens[];
  activeLensId: string | null;
  lensPanelVisible: boolean;
  /** Computed: globalId → hex color for entities matched by active lens */
  lensColorMap: Map<number, string>;
  /** The exact RGBA overlay the active lens last pushed to the shared color
   *  channel, or null when no lens is active. Lets another channel owner
   *  (e.g. the compare overlay) hand control back to the lens on teardown
   *  instead of clearing it. */
  lensAppliedColors: Map<number, [number, number, number, number]> | null;
  /** Computed: globalIds to hide via lens rules */
  lensHiddenIds: Set<number>;
  /** The ids the lens panel pushed into the shared `hiddenEntities` channel on
   *  behalf of the active lens — ONLY ids the lens NEWLY hid (ids the user had
   *  already hidden manually are never claimed). Store-level rather than
   *  component state so a panel unmount/remount keeps ownership and teardown
   *  restores exactly these ids (see lens-visibility-ownership.ts). */
  lensAppliedHiddenIds: number[];
  /** Rule isolation the lens panel applied: the rule id plus the exact ids it
   *  pushed into the shared `isolatedEntities` channel. Store-level so Clear /
   *  toggle / delete can still release the isolation channel after the panel
   *  unmounted and remounted (component-local state would reset to null and
   *  leave the model stuck isolated). */
  lensRuleIsolation: { ruleId: string; entityIds: number[] } | null;
  /** Computed: ruleId → matched entity count for the active lens */
  lensRuleCounts: Map<string, number>;
  /** Computed: ruleId → matched entity global IDs for the active lens */
  lensRuleEntityIds: Map<string, number[]>;
  /** Auto-color legend entries (one per distinct value) for UI display */
  lensAutoColorLegend: AutoColorLegendEntry[];
  /** Discovered data from loaded models (classes instant, rest lazy) */
  discoveredLensData: DiscoveredLensData | null;

  // Lens CRUD (persisted). Each returns a SaveResult so the panel can surface a
  // quota / storage failure; none of them commits to the store unless the write
  // landed, so what the user sees is what survives a reload.
  createLens: (lens: Lens) => SaveResult;
  updateLens: (id: string, patch: Partial<Lens>) => SaveResult;
  deleteLens: (id: string) => SaveResult;
  /**
   * Duplicate a lens (including a built-in) into an editable custom copy
   * inserted right after the original. On success `lens` is the new copy, or
   * null if the source id was not found. (#1403)
   */
  duplicateLens: (id: string) => DuplicateLensResult;
  setActiveLens: (id: string | null) => void;
  toggleLensPanel: () => void;
  setLensPanelVisible: (visible: boolean) => void;
  setLensColorMap: (map: Map<number, string>) => void;
  setLensAppliedColors: (map: Map<number, [number, number, number, number]> | null) => void;
  setLensHiddenIds: (ids: Set<number>) => void;
  setLensAppliedHiddenIds: (ids: number[]) => void;
  setLensRuleIsolation: (isolation: { ruleId: string; entityIds: number[] } | null) => void;
  setLensRuleCounts: (counts: Map<string, number>) => void;
  setLensRuleEntityIds: (ids: Map<string, number[]>) => void;
  setLensAutoColorLegend: (legend: AutoColorLegendEntry[]) => void;
  setDiscoveredLensData: (data: DiscoveredLensData | null) => void;
  /** Merge lazy-discovered data sources (psets, quantities, etc.) into existing discovered data */
  mergeDiscoveredData: (patch: Partial<DiscoveredLensData>) => void;
  /** Get the active lens configuration */
  getActiveLens: () => Lens | null;
  /**
   * Import lenses from a parsed JSON value (array of unknowns). Upserts by id
   * so an export → edit → re-import round-trip updates lenses in place rather
   * than silently no-op'ing on id collisions. (#1403)
   */
  importLenses: (lenses: readonly unknown[]) => SaveResult;
  /**
   * Replace the entire saved-lens set (custom + builtin overrides). Used
   * when activating a flavor: the flavor's stored lens snapshot becomes
   * the new viewer state. Builtins missing from `lenses` are restored
   * from defaults so the user never ends up with an empty lens panel.
   */
  setSavedLenses: (lenses: Lens[]) => SaveResult;
  /** Export all lenses (builtins + custom) as serializable array */
  exportLenses: () => Lens[];
  /** Create and activate an auto-color lens from a data column spec */
  activateAutoColorFromColumn: (spec: AutoColorSpec, label: string) => void;
}

export const createLensSlice: StateCreator<LensSlice, [], [], LensSlice> = (set, get) => ({
  // Initial state — builtins (with user overrides applied) + custom lenses
  savedLenses: buildInitialLenses(),
  activeLensId: null,
  lensPanelVisible: false,
  lensColorMap: new Map(),
  lensAppliedColors: null,
  lensHiddenIds: new Set(),
  lensAppliedHiddenIds: [],
  lensRuleIsolation: null,
  lensRuleCounts: new Map(),
  lensRuleEntityIds: new Map(),
  lensAutoColorLegend: [],
  discoveredLensData: null,

  // Actions
  createLens: (lens) => {
    const next = [...get().savedLenses, lens];
    const result = saveLenses(next);
    if (result.ok) set({ savedLenses: next });
    return result;
  },

  updateLens: (id, patch) => {
    const next = get().savedLenses.map(l => l.id === id ? { ...l, ...patch } : l);
    const result = saveLenses(next);
    if (result.ok) set({ savedLenses: next });
    return result;
  },

  deleteLens: (id) => {
    const state = get();
    const lens = state.savedLenses.find(l => l.id === id);
    if (lens?.builtin) return { ok: true }; // built-ins are reset, never deleted
    const next = state.savedLenses.filter(l => l.id !== id);
    const result = saveLenses(next);
    if (result.ok) {
      set({
        savedLenses: next,
        activeLensId: state.activeLensId === id ? null : state.activeLensId,
      });
    }
    return result;
  },

  duplicateLens: (id) => {
    const state = get();
    const index = state.savedLenses.findIndex(l => l.id === id);
    if (index === -1) return { ok: true, lens: null };
    const taken = new Set(state.savedLenses.map(l => l.id));
    const copy = duplicateLensConfig(state.savedLenses[index], () => reserveUniqueId(`lens-${Date.now()}`, taken));
    const next = [...state.savedLenses];
    next.splice(index + 1, 0, copy);
    const result = saveLenses(next);
    if (!result.ok) return result;
    set({ savedLenses: next });
    return { ok: true, lens: copy };
  },

  setActiveLens: (activeLensId) => set({ activeLensId }),

  toggleLensPanel: () => set((state) => ({ lensPanelVisible: !state.lensPanelVisible })),
  setLensPanelVisible: (lensPanelVisible) => set({ lensPanelVisible }),

  setLensColorMap: (lensColorMap) => set({ lensColorMap }),
  setLensAppliedColors: (lensAppliedColors) => set({ lensAppliedColors }),
  setLensHiddenIds: (lensHiddenIds) => set({ lensHiddenIds }),
  setLensAppliedHiddenIds: (lensAppliedHiddenIds) => set({ lensAppliedHiddenIds }),
  setLensRuleIsolation: (lensRuleIsolation) => set({ lensRuleIsolation }),
  setLensRuleCounts: (lensRuleCounts) => set({ lensRuleCounts }),
  setLensRuleEntityIds: (lensRuleEntityIds) => set({ lensRuleEntityIds }),
  setLensAutoColorLegend: (lensAutoColorLegend) => set({ lensAutoColorLegend }),
  setDiscoveredLensData: (discoveredLensData) => set({ discoveredLensData }),
  mergeDiscoveredData: (patch) => set((state) => {
    if (!state.discoveredLensData) return {};
    return { discoveredLensData: { ...state.discoveredLensData, ...patch } };
  }),

  getActiveLens: () => {
    const { savedLenses, activeLensId } = get();
    return savedLenses.find(l => l.id === activeLensId) ?? null;
  },

  importLenses: (lenses) => {
    // Upsert by id: replace existing lenses in place, append new ones.
    // Makes the export → edit-JSON → re-import round-trip work (#1403).
    const state = get();
    const ts = Date.now();
    const taken = new Set(state.savedLenses.map(l => l.id));
    const next = mergeImportedLenses(
      state.savedLenses,
      lenses,
      (i) => reserveUniqueId(`lens-imported-${ts}-${i}`, taken),
    );
    const result = saveLenses(next);
    if (result.ok) set({ savedLenses: next });
    return result;
  },

  exportLenses: () => {
    // Skip the ephemeral "color from list column" lens — it is not a saved lens
    // and would re-add itself under its reserved id on a later import.
    return get().savedLenses
      .filter(l => l.id !== AUTO_COLOR_FROM_LIST_ID)
      .map(({ id, name, rules, autoColor }) => {
        const out: Lens = { id, name, rules };
        if (autoColor) out.autoColor = autoColor;
        return out;
      });
  },

  setSavedLenses: (lenses) => {
    // Keep builtins available even if the incoming snapshot dropped
    // them — otherwise switching flavors could leave the user with no
    // BY IFC CLASS / STRUCTURAL / etc. The incoming list takes
    // precedence (it may carry user overrides).
    const state = get();
    const incomingIds = new Set(lenses.map((l) => l.id));
    const builtinsToKeep = BUILTIN_LENSES
      .filter((b) => !incomingIds.has(b.id))
      .map((b) => ({ ...b }));
    const next = [...builtinsToKeep, ...lenses];
    const result = saveLenses(next);
    // Leaving the previous set in place beats showing a flavor's lenses that
    // vanish on reload — the caller reports the failure.
    if (!result.ok) return result;
    // If the previously active lens id is gone, clear the pointer so
    // the viewer doesn't try to render a missing rule set.
    const activeStillThere = state.activeLensId !== null
      && next.some((l) => l.id === state.activeLensId);
    set({
      savedLenses: next,
      activeLensId: activeStillThere ? state.activeLensId : null,
    });
    return result;
  },

  activateAutoColorFromColumn: (spec, label) => set((state) => {
    const lensId = AUTO_COLOR_FROM_LIST_ID;
    const lens: Lens = {
      id: lensId,
      name: `Color by ${label}`,
      rules: [],
      autoColor: spec,
    };
    // Replace existing ephemeral lens or add new
    const filtered = state.savedLenses.filter(l => l.id !== lensId);
    const next = [...filtered, lens];
    return { savedLenses: next, activeLensId: lensId, lensPanelVisible: true };
  }),
});
