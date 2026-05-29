/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 2D Drawing generation state slice
 *
 * Manages state for generating and viewing 2D architectural drawings
 * (floor plans, sections, elevations) from the 3D model.
 */

import type { StateCreator } from 'zustand';
import type { Drawing2D, GraphicOverrideRule, GraphicOverridePreset } from '@ifc-lite/drawing-2d';
import { BUILT_IN_PRESETS } from '@ifc-lite/drawing-2d';

export type Drawing2DStatus = 'idle' | 'generating' | 'ready' | 'error';

/** Active 2D annotation tool */
export type Annotation2DTool = 'none' | 'measure' | 'polygon-area' | 'text' | 'cloud';

/** Point in 2D drawing coordinates */
export interface Point2D {
  x: number;
  y: number;
}

/** Measurement result */
export interface Measure2DResult {
  id: string;
  start: Point2D;
  end: Point2D;
  distance: number; // in drawing units (typically meters)
}

/** Polygon area measurement result */
export interface PolygonArea2DResult {
  id: string;
  points: Point2D[];  // Closed polygon vertices (drawing coords)
  area: number;       // Computed area in m²
  perimeter: number;  // Computed perimeter in m
}

/** Text box annotation */
export interface TextAnnotation2D {
  id: string;
  position: Point2D;       // Top-left corner (drawing coords)
  text: string;
  fontSize: number;        // Font size in screen px (default 14)
  color: string;           // Text color (default '#000000')
  backgroundColor: string; // Background fill
  borderColor: string;     // Border color
}

/** Cloud (revision cloud) annotation */
export interface CloudAnnotation2D {
  id: string;
  points: Point2D[];  // Rectangle corners (drawing coords, 2 points: topLeft, bottomRight)
  color: string;      // Cloud stroke color (default '#E53935')
  label: string;      // Optional label text inside cloud
}

/** Reference to a selected annotation */
export interface SelectedAnnotation2D {
  type: 'measure' | 'polygon' | 'text' | 'cloud';
  id: string;
}

export interface Drawing2DState {
  /** Current drawing data (null when not generated) */
  drawing2D: Drawing2D | null;
  /** Generation status */
  drawing2DStatus: Drawing2DStatus;
  /** Generation progress (0-100) */
  drawing2DProgress: number;
  /** Progress phase description */
  drawing2DPhase: string;
  /** Error message if generation failed */
  drawing2DError: string | null;
  /** Whether the 2D panel is visible */
  drawing2DPanelVisible: boolean;
  /** Suppress auto-opening 2D panel on next section tool activation */
  suppressNextSection2DPanelAutoOpen: boolean;
  /** SVG content for export (cached) */
  drawing2DSvgContent: string | null;
  /** Display options */
  drawing2DDisplayOptions: {
    showHiddenLines: boolean;
    showHatching: boolean;
    showAnnotations: boolean;
    show3DOverlay: boolean;
    scale: number;
    /** Use authored symbolic representations (Plan/Annotation) when available instead of section cut */
    useSymbolicRepresentations: boolean;
    /**
     * Whether to overlay IfcAnnotation curves, text, and fills on the 2D
     * section view. Filtered to annotations whose world position falls
     * inside the section's view-range on the cut axis (issue #812 follow-up
     * to the IfcAnnotation text feature).
     */
    showIfcAnnotations: boolean;
  };
  /** Available graphic override presets */
  graphicOverridePresets: GraphicOverridePreset[];
  /** Currently active preset ID (null = no preset) */
  activePresetId: string | null;
  /** Custom user-defined override rules */
  customOverrideRules: GraphicOverrideRule[];
  /** Whether to apply graphic overrides */
  overridesEnabled: boolean;
  /** Panel visibility for override editor */
  overridesPanelVisible: boolean;

  // 2D Measure Tool
  /** Whether measure mode is active */
  measure2DMode: boolean;
  /** Start point of current measurement (drawing coords) */
  measure2DStart: Point2D | null;
  /** Current/end point of measurement (drawing coords) */
  measure2DCurrent: Point2D | null;
  /** Whether shift is held for orthogonal constraint */
  measure2DShiftLocked: boolean;
  /** Axis locked to when shift is held ('x' | 'y' | null) */
  measure2DLockedAxis: 'x' | 'y' | null;
  /** Completed measurements */
  measure2DResults: Measure2DResult[];
  /** Current snap point (if snapping to geometry) */
  measure2DSnapPoint: Point2D | null;

  // Annotation Tool System
  /** Active annotation tool (none = pan mode) */
  annotation2DActiveTool: Annotation2DTool;
  /** Current cursor position in drawing coords for preview rendering */
  annotation2DCursorPos: Point2D | null;

  // Polygon Area Measurement
  /** Points being placed for in-progress polygon */
  polygonArea2DPoints: Point2D[];
  /** Completed polygon area measurements */
  polygonArea2DResults: PolygonArea2DResult[];

  // Text Annotations
  /** Placed text annotations */
  textAnnotations2D: TextAnnotation2D[];
  /** ID of text annotation currently being edited (null = none) */
  textAnnotation2DEditing: string | null;

  // Cloud Annotations
  /** Rectangle corners being placed for in-progress cloud (0-2 points) */
  cloudAnnotation2DPoints: Point2D[];
  /** Completed cloud annotations */
  cloudAnnotations2D: CloudAnnotation2D[];

  // Selection
  /** Currently selected annotation (null = none) */
  selectedAnnotation2D: SelectedAnnotation2D | null;
}

export interface Drawing2DSlice extends Drawing2DState {
  // Drawing Actions
  setDrawing2D: (drawing: Drawing2D | null) => void;
  setDrawing2DStatus: (status: Drawing2DStatus) => void;
  setDrawing2DProgress: (progress: number, phase: string) => void;
  setDrawing2DError: (error: string | null) => void;
  setDrawing2DPanelVisible: (visible: boolean) => void;
  setSuppressNextSection2DPanelAutoOpen: (suppress: boolean) => void;
  toggleDrawing2DPanel: () => void;
  setDrawing2DSvgContent: (svg: string | null) => void;
  updateDrawing2DDisplayOptions: (options: Partial<Drawing2DState['drawing2DDisplayOptions']>) => void;
  clearDrawing2D: () => void;

  // Graphic Override Actions
  setActivePreset: (presetId: string | null) => void;
  addCustomRule: (rule: GraphicOverrideRule) => void;
  updateCustomRule: (ruleId: string, updates: Partial<GraphicOverrideRule>) => void;
  removeCustomRule: (ruleId: string) => void;
  clearCustomRules: () => void;
  setOverridesEnabled: (enabled: boolean) => void;
  toggleOverridesEnabled: () => void;
  setOverridesPanelVisible: (visible: boolean) => void;
  toggleOverridesPanel: () => void;
  /** Get all active rules (preset + custom) sorted by priority */
  getActiveOverrideRules: () => GraphicOverrideRule[];

  // 2D Measure Actions
  setMeasure2DMode: (enabled: boolean) => void;
  toggleMeasure2DMode: () => void;
  setMeasure2DStart: (point: Point2D | null) => void;
  setMeasure2DCurrent: (point: Point2D | null) => void;
  setMeasure2DShiftLocked: (locked: boolean, axis?: 'x' | 'y' | null) => void;
  addMeasure2DResult: (result: Measure2DResult) => void;
  removeMeasure2DResult: (id: string) => void;
  clearMeasure2DResults: () => void;
  setMeasure2DSnapPoint: (point: Point2D | null) => void;
  /** Complete current measurement and add to results */
  completeMeasure2D: () => void;
  /** Cancel current measurement */
  cancelMeasure2D: () => void;

  // Annotation Tool Actions
  /** Set active annotation tool (also manages measure2DMode for backward compat) */
  setAnnotation2DActiveTool: (tool: Annotation2DTool) => void;
  /** Update cursor position for annotation previews */
  setAnnotation2DCursorPos: (pos: Point2D | null) => void;

  // Polygon Area Actions
  addPolygonArea2DPoint: (point: Point2D) => void;
  completePolygonArea2D: (area: number, perimeter: number) => void;
  cancelPolygonArea2D: () => void;
  removePolygonArea2DResult: (id: string) => void;
  clearPolygonArea2DResults: () => void;

  // Text Annotation Actions
  addTextAnnotation2D: (annotation: TextAnnotation2D) => void;
  updateTextAnnotation2D: (id: string, updates: Partial<TextAnnotation2D>) => void;
  removeTextAnnotation2D: (id: string) => void;
  setTextAnnotation2DEditing: (id: string | null) => void;
  clearTextAnnotations2D: () => void;

  // Cloud Annotation Actions
  addCloudAnnotation2DPoint: (point: Point2D) => void;
  completeCloudAnnotation2D: (label?: string) => void;
  cancelCloudAnnotation2D: () => void;
  removeCloudAnnotation2D: (id: string) => void;
  clearCloudAnnotations2D: () => void;

  // Selection Actions
  /** Set the selected annotation (null to deselect) */
  setSelectedAnnotation2D: (sel: SelectedAnnotation2D | null) => void;
  /** Delete the currently selected annotation */
  deleteSelectedAnnotation2D: () => void;
  /** Move an annotation to a new origin position (used during drag) */
  moveAnnotation2D: (sel: SelectedAnnotation2D, newOrigin: Point2D) => void;

  // Bulk Actions
  /** Clear all annotations (measurements, polygons, text, clouds) */
  clearAllAnnotations2D: () => void;
}

const getDefaultDisplayOptions = (): Drawing2DState['drawing2DDisplayOptions'] => ({
  showHiddenLines: true,
  showHatching: true,
  showAnnotations: true,
  show3DOverlay: true, // Show 3D overlay by default
  scale: 100, // 1:100 default
  useSymbolicRepresentations: false, // Default to section cut (Body geometry)
  showIfcAnnotations: true, // Mirror the 3D Class Visibility default
});

const getDefaultState = (): Drawing2DState => ({
  drawing2D: null,
  drawing2DStatus: 'idle',
  drawing2DProgress: 0,
  drawing2DPhase: '',
  drawing2DError: null,
  drawing2DPanelVisible: false,
  suppressNextSection2DPanelAutoOpen: false,
  drawing2DSvgContent: null,
  drawing2DDisplayOptions: getDefaultDisplayOptions(),
  // Graphic overrides
  graphicOverridePresets: BUILT_IN_PRESETS,
  activePresetId: 'preset-3d-colors', // Default to IFC Materials
  customOverrideRules: [],
  overridesEnabled: true,
  overridesPanelVisible: false,
  // 2D Measure
  measure2DMode: false,
  measure2DStart: null,
  measure2DCurrent: null,
  measure2DShiftLocked: false,
  measure2DLockedAxis: null,
  measure2DResults: [],
  measure2DSnapPoint: null,
  // Annotation tools
  annotation2DActiveTool: 'none',
  annotation2DCursorPos: null,
  polygonArea2DPoints: [],
  polygonArea2DResults: [],
  textAnnotations2D: [],
  textAnnotation2DEditing: null,
  cloudAnnotation2DPoints: [],
  cloudAnnotations2D: [],
  // Selection
  selectedAnnotation2D: null,
});

export const createDrawing2DSlice: StateCreator<Drawing2DSlice, [], [], Drawing2DSlice> = (set, get) => ({
  // Initial state
  ...getDefaultState(),

  // Drawing Actions
  setDrawing2D: (drawing) => set({
    drawing2D: drawing,
    drawing2DStatus: drawing ? 'ready' : 'idle',
    drawing2DError: null,
  }),

  setDrawing2DStatus: (status) => set({ drawing2DStatus: status }),

  setDrawing2DProgress: (progress, phase) => set({
    drawing2DProgress: progress,
    drawing2DPhase: phase,
  }),

  setDrawing2DError: (error) => set({
    drawing2DError: error,
    drawing2DStatus: error ? 'error' : 'idle',
  }),

  setDrawing2DPanelVisible: (visible) => set({ drawing2DPanelVisible: visible }),
  setSuppressNextSection2DPanelAutoOpen: (suppress) => set({ suppressNextSection2DPanelAutoOpen: suppress }),

  toggleDrawing2DPanel: () => set((state) => ({ drawing2DPanelVisible: !state.drawing2DPanelVisible })),

  setDrawing2DSvgContent: (svg) => set({ drawing2DSvgContent: svg }),

  updateDrawing2DDisplayOptions: (options) => set((state) => ({
    drawing2DDisplayOptions: { ...state.drawing2DDisplayOptions, ...options },
  })),

  clearDrawing2D: () => set(getDefaultState()),

  // Graphic Override Actions
  setActivePreset: (presetId) => set({ activePresetId: presetId }),

  addCustomRule: (rule) => set((state) => ({
    customOverrideRules: [...state.customOverrideRules, rule],
  })),

  updateCustomRule: (ruleId, updates) => set((state) => ({
    customOverrideRules: state.customOverrideRules.map((rule) =>
      rule.id === ruleId ? { ...rule, ...updates } : rule
    ),
  })),

  removeCustomRule: (ruleId) => set((state) => ({
    customOverrideRules: state.customOverrideRules.filter((rule) => rule.id !== ruleId),
  })),

  clearCustomRules: () => set({ customOverrideRules: [] }),

  setOverridesEnabled: (enabled) => set({ overridesEnabled: enabled }),

  toggleOverridesEnabled: () => set((state) => ({ overridesEnabled: !state.overridesEnabled })),

  setOverridesPanelVisible: (visible) => set({ overridesPanelVisible: visible }),

  toggleOverridesPanel: () => set((state) => ({ overridesPanelVisible: !state.overridesPanelVisible })),

  getActiveOverrideRules: () => {
    const state = get();
    if (!state.overridesEnabled) return [];

    const presetRules: GraphicOverrideRule[] = [];

    // Get rules from active preset
    if (state.activePresetId) {
      const preset = state.graphicOverridePresets.find((p) => p.id === state.activePresetId);
      if (preset) {
        presetRules.push(...preset.rules);
      }
    }

    // Combine with custom rules and sort by priority
    const allRules = [...presetRules, ...state.customOverrideRules];
    return allRules
      .filter((rule) => rule.enabled)
      .sort((a, b) => a.priority - b.priority);
  },

  // 2D Measure Actions
  setMeasure2DMode: (enabled) => set({
    measure2DMode: enabled,
    // Clear measurement state when disabling
    ...(enabled ? {} : {
      measure2DStart: null,
      measure2DCurrent: null,
      measure2DShiftLocked: false,
      measure2DLockedAxis: null,
      measure2DSnapPoint: null,
    }),
  }),

  toggleMeasure2DMode: () => {
    const state = get();
    set({
      measure2DMode: !state.measure2DMode,
      // Clear measurement state when disabling
      ...(!state.measure2DMode ? {} : {
        measure2DStart: null,
        measure2DCurrent: null,
        measure2DShiftLocked: false,
        measure2DLockedAxis: null,
        measure2DSnapPoint: null,
      }),
    });
  },

  setMeasure2DStart: (point) => set({ measure2DStart: point }),

  setMeasure2DCurrent: (point) => set({ measure2DCurrent: point }),

  setMeasure2DShiftLocked: (locked, axis = null) => set({
    measure2DShiftLocked: locked,
    measure2DLockedAxis: locked ? axis : null,
  }),

  addMeasure2DResult: (result) => set((state) => ({
    measure2DResults: [...state.measure2DResults, result],
  })),

  removeMeasure2DResult: (id) => set((state) => ({
    measure2DResults: state.measure2DResults.filter((r) => r.id !== id),
  })),

  clearMeasure2DResults: () => set({ measure2DResults: [] }),

  setMeasure2DSnapPoint: (point) => set({ measure2DSnapPoint: point }),

  completeMeasure2D: () => {
    const state = get();
    if (state.measure2DStart && state.measure2DCurrent) {
      const start = state.measure2DStart;
      const end = state.measure2DCurrent;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // Ignore zero-length measurements (click without drag)
      const MIN_MEASUREMENT_DISTANCE = 0.001; // 1mm minimum
      if (distance < MIN_MEASUREMENT_DISTANCE) {
        // Reset state without saving the measurement
        set({
          measure2DStart: null,
          measure2DCurrent: null,
          measure2DShiftLocked: false,
          measure2DLockedAxis: null,
          measure2DSnapPoint: null,
        });
        return;
      }

      const result: Measure2DResult = {
        id: `measure-${Date.now()}`,
        start,
        end,
        distance,
      };

      set({
        measure2DResults: [...state.measure2DResults, result],
        measure2DStart: null,
        measure2DCurrent: null,
        measure2DShiftLocked: false,
        measure2DLockedAxis: null,
        measure2DSnapPoint: null,
      });
    }
  },

  cancelMeasure2D: () => set({
    measure2DStart: null,
    measure2DCurrent: null,
    measure2DShiftLocked: false,
    measure2DLockedAxis: null,
    measure2DSnapPoint: null,
  }),

  // ═══════════════════════════════════════════════════════════════════════
  // ANNOTATION TOOL ACTIONS
  // ═══════════════════════════════════════════════════════════════════════

  setAnnotation2DActiveTool: (tool) => {
    const state = get();
    // Cancel any in-progress work from previous tool
    const resetState: Partial<Drawing2DState> = {
      annotation2DActiveTool: tool,
      annotation2DCursorPos: null,
      // Keep measure2DMode in sync for backward compatibility
      measure2DMode: tool === 'measure',
      // Clear in-progress state from all tools
      measure2DStart: null,
      measure2DCurrent: null,
      measure2DShiftLocked: false,
      measure2DLockedAxis: null,
      measure2DSnapPoint: null,
      polygonArea2DPoints: [],
      cloudAnnotation2DPoints: [],
      textAnnotation2DEditing: null,
      selectedAnnotation2D: null,
    };
    set(resetState);
  },

  setAnnotation2DCursorPos: (pos) => set({ annotation2DCursorPos: pos }),

  // Polygon Area Actions
  addPolygonArea2DPoint: (point) => set((state) => ({
    polygonArea2DPoints: [...state.polygonArea2DPoints, point],
  })),

  completePolygonArea2D: (area, perimeter) => {
    const state = get();
    if (state.polygonArea2DPoints.length < 3) return;

    const result: PolygonArea2DResult = {
      id: `poly-area-${Date.now()}`,
      points: [...state.polygonArea2DPoints],
      area,
      perimeter,
    };

    set({
      polygonArea2DResults: [...state.polygonArea2DResults, result],
      polygonArea2DPoints: [],
      annotation2DCursorPos: null,
    });
  },

  cancelPolygonArea2D: () => set({
    polygonArea2DPoints: [],
    annotation2DCursorPos: null,
  }),

  removePolygonArea2DResult: (id) => set((state) => ({
    polygonArea2DResults: state.polygonArea2DResults.filter((r) => r.id !== id),
  })),

  clearPolygonArea2DResults: () => set({ polygonArea2DResults: [] }),

  // Text Annotation Actions
  addTextAnnotation2D: (annotation) => set((state) => ({
    textAnnotations2D: [...state.textAnnotations2D, annotation],
  })),

  updateTextAnnotation2D: (id, updates) => set((state) => ({
    textAnnotations2D: state.textAnnotations2D.map((a) =>
      a.id === id ? { ...a, ...updates } : a
    ),
  })),

  removeTextAnnotation2D: (id) => set((state) => ({
    textAnnotations2D: state.textAnnotations2D.filter((a) => a.id !== id),
    textAnnotation2DEditing: state.textAnnotation2DEditing === id ? null : state.textAnnotation2DEditing,
  })),

  setTextAnnotation2DEditing: (id) => set({ textAnnotation2DEditing: id }),

  clearTextAnnotations2D: () => set({
    textAnnotations2D: [],
    textAnnotation2DEditing: null,
  }),

  // Cloud Annotation Actions
  addCloudAnnotation2DPoint: (point) => set((state) => ({
    cloudAnnotation2DPoints: [...state.cloudAnnotation2DPoints, point],
  })),

  completeCloudAnnotation2D: (label = '') => {
    const state = get();
    if (state.cloudAnnotation2DPoints.length < 2) return;

    const result: CloudAnnotation2D = {
      id: `cloud-${Date.now()}`,
      points: [...state.cloudAnnotation2DPoints],
      color: '#E53935',
      label,
    };

    set({
      cloudAnnotations2D: [...state.cloudAnnotations2D, result],
      cloudAnnotation2DPoints: [],
      annotation2DCursorPos: null,
    });
  },

  cancelCloudAnnotation2D: () => set({
    cloudAnnotation2DPoints: [],
    annotation2DCursorPos: null,
  }),

  removeCloudAnnotation2D: (id) => set((state) => ({
    cloudAnnotations2D: state.cloudAnnotations2D.filter((a) => a.id !== id),
  })),

  clearCloudAnnotations2D: () => set({ cloudAnnotations2D: [] }),

  // Selection Actions
  setSelectedAnnotation2D: (sel) => set({ selectedAnnotation2D: sel }),

  deleteSelectedAnnotation2D: () => {
    const state = get();
    const sel = state.selectedAnnotation2D;
    if (!sel) return;

    switch (sel.type) {
      case 'measure':
        set({ measure2DResults: state.measure2DResults.filter((r) => r.id !== sel.id), selectedAnnotation2D: null });
        break;
      case 'polygon':
        set({ polygonArea2DResults: state.polygonArea2DResults.filter((r) => r.id !== sel.id), selectedAnnotation2D: null });
        break;
      case 'text':
        set({
          textAnnotations2D: state.textAnnotations2D.filter((a) => a.id !== sel.id),
          selectedAnnotation2D: null,
          textAnnotation2DEditing: state.textAnnotation2DEditing === sel.id ? null : state.textAnnotation2DEditing,
        });
        break;
      case 'cloud':
        set({ cloudAnnotations2D: state.cloudAnnotations2D.filter((a) => a.id !== sel.id), selectedAnnotation2D: null });
        break;
    }
  },

  moveAnnotation2D: (sel, newOrigin) => {
    const state = get();
    switch (sel.type) {
      case 'measure': {
        const result = state.measure2DResults.find((r) => r.id === sel.id);
        if (!result) return;
        const dx = newOrigin.x - result.start.x;
        const dy = newOrigin.y - result.start.y;
        set({ measure2DResults: state.measure2DResults.map((r) =>
          r.id === sel.id ? { ...r, start: { x: r.start.x + dx, y: r.start.y + dy }, end: { x: r.end.x + dx, y: r.end.y + dy } } : r
        ) });
        break;
      }
      case 'polygon': {
        const result = state.polygonArea2DResults.find((r) => r.id === sel.id);
        if (!result) return;
        const dx = newOrigin.x - result.points[0].x;
        const dy = newOrigin.y - result.points[0].y;
        set({ polygonArea2DResults: state.polygonArea2DResults.map((r) =>
          r.id === sel.id ? { ...r, points: r.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : r
        ) });
        break;
      }
      case 'text': {
        set({ textAnnotations2D: state.textAnnotations2D.map((a) =>
          a.id === sel.id ? { ...a, position: newOrigin } : a
        ) });
        break;
      }
      case 'cloud': {
        const cloud = state.cloudAnnotations2D.find((a) => a.id === sel.id);
        if (!cloud || cloud.points.length < 2) return;
        const dx = newOrigin.x - cloud.points[0].x;
        const dy = newOrigin.y - cloud.points[0].y;
        set({ cloudAnnotations2D: state.cloudAnnotations2D.map((a) =>
          a.id === sel.id ? { ...a, points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : a
        ) });
        break;
      }
    }
  },

  // Bulk Actions
  clearAllAnnotations2D: () => set({
    measure2DResults: [],
    measure2DStart: null,
    measure2DCurrent: null,
    measure2DShiftLocked: false,
    measure2DLockedAxis: null,
    measure2DSnapPoint: null,
    polygonArea2DPoints: [],
    polygonArea2DResults: [],
    textAnnotations2D: [],
    textAnnotation2DEditing: null,
    cloudAnnotation2DPoints: [],
    cloudAnnotations2D: [],
    annotation2DCursorPos: null,
    selectedAnnotation2D: null,
  }),
});
