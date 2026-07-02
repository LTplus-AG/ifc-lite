/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash detection panel state (Phase 1). Detection itself lives in
 * `@ifc-lite/clash`; this slice holds the panel's UI state, the last result,
 * and the user's persisted detection settings + rule presets (see
 * `lib/clash/persistence.ts`, modeled on the lens slice). Orchestration
 * (gathering elements, running the engine, applying colors / selection /
 * camera, BCF export) lives in the `useClash` hook.
 */

import type { StateCreator } from 'zustand';
import type { ClashResult, ClashGroup, ClashMode, ClashProgress, ClashSortBy } from '@ifc-lite/clash';

/** How the rest of the model is shown when a clash is focused (#1275). Lives
 *  here (not in `useClash`) so the panel's view choice persists across panel
 *  switches. (#1464) */
export type ClashFocusMode = 'highlight' | 'isolate' | 'ghost';
import {
  buildInitialPresets,
  defaultPresets,
  loadSettings,
  savePresets,
  saveSettings,
  validatePresetName,
  validateSelector,
  CLASH_BOUNDS,
  clampToBounds,
  DEFAULT_CLASH_SETTINGS,
  type ClashPreset,
  type ClashGlobalSettings,
  type ClashSettingsGroupBy,
  type SaveResult,
} from '@/lib/clash/persistence';

export type ClashGroupBy = ClashSettingsGroupBy;
export type { ClashPreset, ClashGlobalSettings, SaveResult };

/** Fields a user supplies when adding a custom rule (id/flags filled in here). */
export type NewClashPreset = {
  name: string;
  description?: string;
  severity: ClashPreset['severity'];
  selectorA: string;
  selectorB: string;
};

export interface ClashSlice {
  clashPanelVisible: boolean;
  clashResult: ClashResult | null;
  clashGroups: ClashGroup[] | null;
  clashRunning: boolean;
  clashError: string | null;
  /** Live detection progress for the running rule (null when idle). */
  clashProgress: ClashProgress | null;
  /** Detection settings (persisted). */
  clashMode: ClashMode;
  clashTolerance: number;
  clashClearance: number;
  clashClusterEpsilon: number;
  clashReportTouch: boolean;
  /** How the result list is organized (persisted). */
  clashGroupBy: ClashGroupBy;
  /** Result-list sort key - view state, kept in the store so it survives a
   *  panel switch instead of resetting to default each time. (#1464) */
  clashSortBy: ClashSortBy;
  /** "Hide touching" result filter - view state, same persistence. (#1464) */
  clashHideTouching: boolean;
  /** On-select focus presentation (highlight / isolate / ghost). (#1464) */
  clashFocusMode: ClashFocusMode;
  /** Built-in + custom rule presets (persisted). */
  clashPresets: ClashPreset[];
  /** Currently focused clash id (for highlight in the list). */
  clashSelectedId: string | null;
  /**
   * Per-element highlight tint for the focused clash pair — `Map<globalId, RGBA>`
   * (element A one vibrant colour, element B another). Fed to the renderer so the
   * selection glow paints A and B distinctly instead of the single selection
   * blue. `null` when no clash is focused. (#1277/#1339)
   */
  clashHighlightColors: Map<number, [number, number, number, number]> | null;
  /**
   * World-space AABB of the focused clash's overlap region (`Clash.bounds`),
   * drawn as a distinct-colour wireframe box so the overlap reads as a third
   * colour next to the two glowing elements. `null` when no clash is focused.
   * (#1277)
   */
  clashOverlapBox: { min: [number, number, number]; max: [number, number, number] } | null;
  /**
   * The focused clash's CONTACT geometry as a flat world-frame line-list (the
   * real shared-face polygon outlines / intersection lines). Preferred over the
   * AABB `clashOverlapBox` when present. `null` when no clash is focused or the
   * contact could not be computed (then the box is used). (#1402)
   */
  clashContactLines: { vertices: number[]; color: [number, number, number, number] } | null;
  /**
   * Whether the focused clash's region box is drawn in the 3D view. On by
   * default (#1402): with the tight contact bounds (#1362 Bug B) the box marks
   * the actual penetration region instead of the old whole-element AABB that
   * obscured everything. It draws on the always-visible overlay so it shows
   * through the (often isolated) clashing solids; toggle it off in clash settings.
   */
  showClashRegionBox: boolean;

  setClashPanelVisible: (visible: boolean) => void;
  toggleClashPanel: () => void;
  setClashResult: (result: ClashResult | null) => void;
  setClashGroups: (groups: ClashGroup[] | null) => void;
  setClashRunning: (running: boolean) => void;
  setClashError: (error: string | null) => void;
  setClashProgress: (progress: ClashProgress | null) => void;
  setClashMode: (mode: ClashMode) => void;
  setClashTolerance: (tolerance: number) => void;
  setClashClearance: (clearance: number) => void;
  setClashClusterEpsilon: (epsilon: number) => void;
  setClashReportTouch: (reportTouch: boolean) => void;
  setClashGroupBy: (groupBy: ClashGroupBy) => void;
  setClashSortBy: (sortBy: ClashSortBy) => void;
  setClashHideTouching: (hide: boolean) => void;
  setClashFocusMode: (mode: ClashFocusMode) => void;
  resetClashSettings: () => void;
  setClashSelectedId: (id: string | null) => void;
  setClashHighlightColors: (colors: Map<number, [number, number, number, number]> | null) => void;
  setClashOverlapBox: (box: { min: [number, number, number]; max: [number, number, number] } | null) => void;
  setClashContactLines: (lines: { vertices: number[]; color: [number, number, number, number] } | null) => void;
  setShowClashRegionBox: (show: boolean) => void;
  // Preset CRUD (persisted). create/update/import return a SaveResult so the UI
  // can surface quota / cap failures; the rest are best-effort.
  createClashPreset: (input: NewClashPreset) => SaveResult;
  updateClashPreset: (id: string, patch: Partial<Omit<ClashPreset, 'id' | 'builtin'>>) => SaveResult;
  deleteClashPreset: (id: string) => void;
  setClashPresetEnabled: (id: string, enabled: boolean) => void;
  resetClashPresets: () => void;
  importClashPresets: (presets: ClashPreset[]) => SaveResult;
  /**
   * Replace the entire clash config (presets + detection settings) and persist.
   * Used when activating a flavor/profile so each one carries its own rule-set.
   */
  applyClashFlavorConfig: (config: { presets: ClashPreset[]; settings: ClashGlobalSettings }) => void;
  clearClash: () => void;
}

/** Build the persisted settings blob from current slice state. */
function snapshotSettings(s: ClashSlice): ClashGlobalSettings {
  return {
    mode: s.clashMode,
    tolerance: s.clashTolerance,
    clearance: s.clashClearance,
    clusterEpsilon: s.clashClusterEpsilon,
    reportTouch: s.clashReportTouch,
    groupBy: s.clashGroupBy,
  };
}

export const createClashSlice: StateCreator<ClashSlice, [], [], ClashSlice> = (set, get) => {
  const initial = loadSettings();
  // Persist the current settings snapshot after a state change.
  const persistSettings = () => saveSettings(snapshotSettings(get()));

  return {
    clashPanelVisible: false,
    clashResult: null,
    clashGroups: null,
    clashRunning: false,
    clashError: null,
    clashProgress: null,
    clashMode: initial.mode,
    clashTolerance: initial.tolerance,
    clashClearance: initial.clearance,
    clashClusterEpsilon: initial.clusterEpsilon,
    clashReportTouch: initial.reportTouch,
    clashGroupBy: initial.groupBy,
    clashSortBy: 'severity',
    clashHideTouching: false,
    clashFocusMode: 'highlight',
    clashPresets: buildInitialPresets(),
    clashSelectedId: null,
    clashHighlightColors: null,
    clashOverlapBox: null,
    clashContactLines: null,
    showClashRegionBox: true,

    setClashPanelVisible: (clashPanelVisible) => set({ clashPanelVisible }),
    toggleClashPanel: () => set((s) => ({ clashPanelVisible: !s.clashPanelVisible })),
    setClashResult: (clashResult) => set({ clashResult }),
    setClashGroups: (clashGroups) => set({ clashGroups }),
    setClashRunning: (clashRunning) => set({ clashRunning }),
    setClashError: (clashError) => set({ clashError }),
    setClashProgress: (clashProgress) => set({ clashProgress }),

    setClashMode: (clashMode) => { set({ clashMode }); persistSettings(); },
    setClashTolerance: (clashTolerance) => {
      set({ clashTolerance: clampToBounds(clashTolerance, CLASH_BOUNDS.tolerance, DEFAULT_CLASH_SETTINGS.tolerance) });
      persistSettings();
    },
    setClashClearance: (clashClearance) => {
      set({ clashClearance: clampToBounds(clashClearance, CLASH_BOUNDS.clearance, DEFAULT_CLASH_SETTINGS.clearance) });
      persistSettings();
    },
    setClashClusterEpsilon: (clashClusterEpsilon) => {
      set({ clashClusterEpsilon: clampToBounds(clashClusterEpsilon, CLASH_BOUNDS.clusterEpsilon, DEFAULT_CLASH_SETTINGS.clusterEpsilon) });
      persistSettings();
    },
    setClashReportTouch: (clashReportTouch) => { set({ clashReportTouch }); persistSettings(); },
    setClashGroupBy: (clashGroupBy) => { set({ clashGroupBy }); persistSettings(); },
    // View-state setters: kept in the store (not localStorage) so they survive a
    // panel switch within the session without growing the persisted blob. (#1464)
    setClashSortBy: (clashSortBy) => set({ clashSortBy }),
    setClashHideTouching: (clashHideTouching) => set({ clashHideTouching }),
    setClashFocusMode: (clashFocusMode) => set({ clashFocusMode }),
    resetClashSettings: () => {
      set({
        clashMode: DEFAULT_CLASH_SETTINGS.mode,
        clashTolerance: DEFAULT_CLASH_SETTINGS.tolerance,
        clashClearance: DEFAULT_CLASH_SETTINGS.clearance,
        clashClusterEpsilon: DEFAULT_CLASH_SETTINGS.clusterEpsilon,
        clashReportTouch: DEFAULT_CLASH_SETTINGS.reportTouch,
        clashGroupBy: DEFAULT_CLASH_SETTINGS.groupBy,
        showClashRegionBox: true,
      });
      persistSettings();
    },

    setClashSelectedId: (clashSelectedId) => set({ clashSelectedId }),
    setClashHighlightColors: (clashHighlightColors) => set({ clashHighlightColors }),
    setClashOverlapBox: (clashOverlapBox) => set({ clashOverlapBox }),
    setClashContactLines: (clashContactLines) => set({ clashContactLines }),
    setShowClashRegionBox: (showClashRegionBox) => set({ showClashRegionBox }),

    createClashPreset: (input) => {
      const name = validatePresetName(input.name);
      const selectorA = validateSelector(input.selectorA);
      const selectorB = validateSelector(input.selectorB);
      if (!name || !selectorA || !selectorB) {
        return { ok: false, reason: 'serialize', message: 'Name and both selectors are required.' };
      }
      const preset: ClashPreset = {
        id: `custom-${crypto.randomUUID()}`,
        name,
        description: input.description?.trim() ?? '',
        severity: input.severity,
        selectorA,
        selectorB,
        enabled: true,
        builtin: false,
      };
      const next = [...get().clashPresets, preset];
      const result = savePresets(next);
      if (result.ok) set({ clashPresets: next });
      return result;
    },

    updateClashPreset: (id, patch) => {
      const next = get().clashPresets.map((p) => (p.id === id ? { ...p, ...patch } : p));
      const result = savePresets(next);
      if (result.ok) set({ clashPresets: next });
      return result;
    },

    deleteClashPreset: (id) => {
      const target = get().clashPresets.find((p) => p.id === id);
      if (!target || target.builtin) return; // built-ins are reset, never deleted
      const next = get().clashPresets.filter((p) => p.id !== id);
      savePresets(next);
      set({ clashPresets: next });
    },

    setClashPresetEnabled: (id, enabled) => {
      const next = get().clashPresets.map((p) => (p.id === id ? { ...p, enabled } : p));
      savePresets(next);
      set({ clashPresets: next });
    },

    resetClashPresets: () => {
      const next = defaultPresets(); // drops all overrides + customs
      savePresets(next);
      set({ clashPresets: next });
    },

    importClashPresets: (presets) => {
      const next = [...get().clashPresets, ...presets.filter((p) => !p.builtin)];
      const result = savePresets(next);
      if (result.ok) set({ clashPresets: next });
      return result;
    },

    applyClashFlavorConfig: ({ presets, settings }) => {
      set({
        clashPresets: presets,
        clashMode: settings.mode,
        clashTolerance: settings.tolerance,
        clashClearance: settings.clearance,
        clashClusterEpsilon: settings.clusterEpsilon,
        clashReportTouch: settings.reportTouch,
        clashGroupBy: settings.groupBy,
      });
      // Persist so the activated flavor's config becomes the working set on reload.
      savePresets(presets);
      saveSettings(settings);
    },

    clearClash: () =>
      // Keep presets + settings (workspace prefs, like saved lenses): only the
      // run result/panel state is cleared.
      set({
        clashResult: null,
        clashGroups: null,
        clashRunning: false,
        clashError: null,
        clashProgress: null,
        clashSelectedId: null,
        clashHighlightColors: null,
        clashOverlapBox: null,
    clashContactLines: null,
      }),
  };
};
