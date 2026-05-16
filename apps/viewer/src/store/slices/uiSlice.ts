/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * UI state slice
 */

import type { StateCreator } from 'zustand';
import { MERGE_LAYERS_STORAGE_KEY, UI_DEFAULTS } from '../constants.js';
import type { ContactShadingQuality, SeparationLinesQuality } from '@ifc-lite/renderer';
import type { FederatedModel } from '../types.js';
import type { GeometryResult } from '@ifc-lite/geometry';
import type { CesiumPlacementDraft } from './cesiumSlice.js';

export type ThemeMode = 'light' | 'dark' | 'colorful';

/**
 * Cross-slice surface UISlice reaches into via the combined Zustand
 * `get()` to decide whether toggling a load-time setting needs a
 * reload (only meaningful while a model is in scope).
 */
export interface UICrossSliceState {
  models: Map<string, FederatedModel>;
  geometryResult: GeometryResult | null;
  /**
   * Cesium placement draft state owned by `CesiumSlice`. UISlice
   * reaches in to clear it when global edit mode flips off, so that
   * "exit edit" really exits everything (the placement editor, the
   * draft values, the active tool) in a single atomic update.
   */
  cesiumPlacementEditMode: boolean;
  cesiumPlacementDraftModelId: string | null;
  cesiumPlacementDraft: CesiumPlacementDraft | null;
}

export interface UISlice {
  // State
  leftPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  activeTool: string;
  /**
   * Global edit mode. When `true`, all in-place editing affordances
   * (inline property/attribute editors, future geometry manipulators,
   * georeference placement, the add-element draw tools) are unlocked.
   * When `false` the viewer is strictly read-only — this is the
   * default. The toggle is surfaced as a single pill in the main
   * toolbar so the user has one switch for "am I editing anything?"
   * rather than per-panel toggles.
   */
  editEnabled: boolean;
  theme: ThemeMode;
  isMobile: boolean;
  hoverTooltipsEnabled: boolean;
  visualEnhancementsEnabled: boolean;
  edgeContrastEnabled: boolean;
  edgeContrastIntensity: number;
  contactShadingQuality: ContactShadingQuality;
  contactShadingIntensity: number;
  contactShadingRadius: number;
  separationLinesEnabled: boolean;
  separationLinesQuality: SeparationLinesQuality;
  separationLinesIntensity: number;
  separationLinesRadius: number;
  /**
   * Issue #540 — "Merge Multilayer Walls" load-time toggle. Reading
   * this on next file load is what the WASM bridge actually uses;
   * flipping it while a model is in scope sets
   * `mergeLayersPendingReload` so the UI can prompt the user.
   */
  mergeLayers: boolean;
  /** True after the user flipped `mergeLayers` while a model was loaded. */
  mergeLayersPendingReload: boolean;

  // Actions
  setLeftPanelCollapsed: (collapsed: boolean) => void;
  setRightPanelCollapsed: (collapsed: boolean) => void;
  setActiveTool: (tool: string) => void;
  setEditEnabled: (enabled: boolean) => void;
  toggleEditEnabled: () => void;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;
  /** Shift+click secret: toggle colorful mode on/off */
  toggleColorful: () => void;
  setIsMobile: (isMobile: boolean) => void;
  toggleHoverTooltips: () => void;
  setVisualEnhancementsEnabled: (enabled: boolean) => void;
  setEdgeContrastEnabled: (enabled: boolean) => void;
  setEdgeContrastIntensity: (intensity: number) => void;
  setContactShadingQuality: (quality: ContactShadingQuality) => void;
  setContactShadingIntensity: (intensity: number) => void;
  setContactShadingRadius: (radius: number) => void;
  setSeparationLinesEnabled: (enabled: boolean) => void;
  setSeparationLinesQuality: (quality: SeparationLinesQuality) => void;
  setSeparationLinesIntensity: (intensity: number) => void;
  setSeparationLinesRadius: (radius: number) => void;
  /** Update the merge-layers toggle and persist to localStorage. */
  setMergeLayers: (v: boolean) => void;
  /** Acknowledge the reload banner without performing a reload. */
  clearMergeLayersPendingReload: () => void;
}

/** Apply the correct CSS classes on <html> for the given theme */
function applyThemeClasses(theme: ThemeMode) {
  const el = document.documentElement;
  el.classList.toggle('dark', theme === 'dark');
  el.classList.toggle('colorful', theme === 'colorful');
}

/**
 * Returns true when any geometry is loaded — federated model map has
 * entries OR the legacy single-model `geometryResult` is non-null with
 * at least one mesh. Centralised here so the merge-layers toggle has
 * a single source of truth for "is a model loaded?".
 */
function hasLoadedModel(state: UICrossSliceState): boolean {
  if (state.models.size > 0) return true;
  return (state.geometryResult?.meshes.length ?? 0) > 0;
}

export const createUISlice: StateCreator<UISlice & UICrossSliceState, [], [], UISlice> = (set, get) => ({
  // Initial state
  leftPanelCollapsed: false,
  rightPanelCollapsed: false,
  activeTool: UI_DEFAULTS.ACTIVE_TOOL,
  editEnabled: false,
  theme: UI_DEFAULTS.THEME,
  isMobile: false,
  hoverTooltipsEnabled: UI_DEFAULTS.HOVER_TOOLTIPS_ENABLED,
  visualEnhancementsEnabled: UI_DEFAULTS.VISUAL_ENHANCEMENTS_ENABLED,
  edgeContrastEnabled: UI_DEFAULTS.EDGE_CONTRAST_ENABLED,
  edgeContrastIntensity: UI_DEFAULTS.EDGE_CONTRAST_INTENSITY,
  contactShadingQuality: UI_DEFAULTS.CONTACT_SHADING_QUALITY,
  contactShadingIntensity: UI_DEFAULTS.CONTACT_SHADING_INTENSITY,
  contactShadingRadius: UI_DEFAULTS.CONTACT_SHADING_RADIUS,
  separationLinesEnabled: UI_DEFAULTS.SEPARATION_LINES_ENABLED,
  separationLinesQuality: UI_DEFAULTS.SEPARATION_LINES_QUALITY,
  separationLinesIntensity: UI_DEFAULTS.SEPARATION_LINES_INTENSITY,
  separationLinesRadius: UI_DEFAULTS.SEPARATION_LINES_RADIUS,
  mergeLayers: UI_DEFAULTS.MERGE_LAYERS,
  mergeLayersPendingReload: false,

  // Actions
  setLeftPanelCollapsed: (leftPanelCollapsed) => set({ leftPanelCollapsed }),
  setRightPanelCollapsed: (rightPanelCollapsed) => set({ rightPanelCollapsed }),
  setActiveTool: (activeTool) => {
    // Authoring tools require edit mode. Entering one of them flips
    // the global toggle on so the rest of the UI (Properties panel,
    // future manipulators) stays in sync. Read-only tools leave the
    // flag alone.
    const requiresEdit =
      activeTool === 'addElement' ||
      activeTool === 'cesium-placement' ||
      activeTool === 'split';
    set(requiresEdit ? { activeTool, editEnabled: true } : { activeTool });
  },
  setEditEnabled: (editEnabled) => {
    if (!editEnabled) {
      // Flipping edit mode off must clear every authoring sub-state
      // that depends on it — otherwise the viewer ends up "not in
      // edit mode" but still carrying a georef draft or a half-drawn
      // slab polygon. Cross-slice reset lives here so callers don't
      // have to remember to mop up.
      set((s) => ({
        editEnabled: false,
        activeTool:
          s.activeTool === 'addElement' ||
          s.activeTool === 'cesium-placement' ||
          s.activeTool === 'split'
            ? 'select'
            : s.activeTool,
        cesiumPlacementEditMode: false,
        cesiumPlacementDraftModelId: null,
        cesiumPlacementDraft: null,
      }));
      return;
    }
    set({ editEnabled: true });
  },
  toggleEditEnabled: () => {
    get().setEditEnabled(!get().editEnabled);
  },

  setTheme: (theme) => {
    applyThemeClasses(theme);
    localStorage.setItem('ifc-lite-theme', theme);
    set({ theme });
  },

  toggleTheme: () => {
    // Normal toggle: dark ↔ light. If currently colorful, drop to dark.
    const current = get().theme;
    const newTheme = current === 'dark' ? 'light' : 'dark';
    applyThemeClasses(newTheme);
    localStorage.setItem('ifc-lite-theme', newTheme);
    set({ theme: newTheme });
  },

  toggleColorful: () => {
    // Shift+click secret: toggle colorful on/off
    // Into colorful from any state. Out of colorful → light (the storm clears).
    const current = get().theme;
    const newTheme: ThemeMode = current === 'colorful' ? 'light' : 'colorful';
    applyThemeClasses(newTheme);
    localStorage.setItem('ifc-lite-theme', newTheme);
    set({ theme: newTheme });
  },

  setIsMobile: (isMobile) => set({ isMobile }),
  toggleHoverTooltips: () => set((state) => ({ hoverTooltipsEnabled: !state.hoverTooltipsEnabled })),
  setVisualEnhancementsEnabled: (visualEnhancementsEnabled) => set({ visualEnhancementsEnabled }),
  setEdgeContrastEnabled: (edgeContrastEnabled) => set({ edgeContrastEnabled }),
  setEdgeContrastIntensity: (edgeContrastIntensity) => set({ edgeContrastIntensity }),
  setContactShadingQuality: (contactShadingQuality) => set({ contactShadingQuality }),
  setContactShadingIntensity: (contactShadingIntensity) => set({ contactShadingIntensity }),
  setContactShadingRadius: (contactShadingRadius) => set({ contactShadingRadius }),
  setSeparationLinesEnabled: (separationLinesEnabled) => set({ separationLinesEnabled }),
  setSeparationLinesQuality: (separationLinesQuality) => set({ separationLinesQuality }),
  setSeparationLinesIntensity: (separationLinesIntensity) => set({ separationLinesIntensity }),
  setSeparationLinesRadius: (separationLinesRadius) => set({ separationLinesRadius }),

  setMergeLayers: (next) => {
    const current = get();
    if (current.mergeLayers === next) return;
    // Persist eagerly so the next page-load picks the same value up
    // through `getInitialMergeLayers` (constants.ts). Wrap in
    // try/catch — Safari private mode / locked storage throws.
    try {
      localStorage.setItem(MERGE_LAYERS_STORAGE_KEY, String(next));
    } catch {
      /* storage unavailable — accept the in-memory toggle silently */
    }
    // Only ask the user to reload if a model is currently in scope.
    // Toggling the setting on an empty viewer simply changes the
    // future load behaviour with no visible effect.
    const pending = hasLoadedModel(current);
    set({ mergeLayers: next, mergeLayersPendingReload: pending });
  },

  clearMergeLayersPendingReload: () => set({ mergeLayersPendingReload: false }),
});
