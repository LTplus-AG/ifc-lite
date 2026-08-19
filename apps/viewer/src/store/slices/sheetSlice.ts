/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sheet Slice - Zustand state for drawing sheet configuration
 *
 * Manages:
 * - Paper size selection
 * - Drawing frames
 * - Title blocks with editable fields
 * - Scale bars and north arrows
 * - Sheet templates
 */

import type { StateCreator } from 'zustand';
import type {
  DrawingSheet,
  TitleBlockField,
  TitleBlockLogo,
  RevisionEntry,
  SheetCreationOptions,
  FrameStyle,
  TitleBlockLayout,
  ScaleBarConfig,
  NorthArrowConfig,
  FrameMargins,
  DrawingScale,
} from '@ifc-lite/drawing-2d';
import {
  PAPER_SIZE_REGISTRY,
  FRAME_PRESETS,
  TITLE_BLOCK_PRESETS,
  DEFAULT_TITLE_BLOCK_FIELDS,
  DEFAULT_SCALE_BAR,
  DEFAULT_NORTH_ARROW,
  COMMON_SCALES,
  calculateViewportBounds,
  calculateOptimalScaleBarLength,
} from '@ifc-lite/drawing-2d';

// ═══════════════════════════════════════════════════════════════════════════
// STATE TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface SheetState {
  /** Current active sheet configuration */
  activeSheet: DrawingSheet | null;
  /** Sheet enabled for export (vs raw drawing) */
  sheetEnabled: boolean;
  /** Sheet setup panel visibility */
  sheetPanelVisible: boolean;
  /** Title block editor visibility */
  titleBlockEditorVisible: boolean;
  /** Saved sheet templates */
  savedSheetTemplates: DrawingSheet[];
}

export interface SheetSlice extends SheetState {
  // Sheet Actions
  createSheet: (options?: SheetCreationOptions) => void;
  updateSheet: (updates: Partial<DrawingSheet>) => void;
  clearSheet: () => void;
  setSheetEnabled: (enabled: boolean) => void;
  toggleSheetEnabled: () => void;

  // Paper/Frame Actions
  setPaperSize: (paperId: string) => void;
  setFrameStyle: (style: FrameStyle) => void;
  updateFrameMargins: (margins: Partial<FrameMargins>) => void;
  setDrawingScale: (scale: DrawingScale) => void;

  // Title Block Actions
  setTitleBlockLayout: (layout: TitleBlockLayout) => void;
  updateTitleBlockField: (fieldId: string, value: string) => void;
  addTitleBlockField: (field: TitleBlockField) => void;
  removeTitleBlockField: (fieldId: string) => void;
  setTitleBlockLogo: (logo: TitleBlockLogo | null) => void;
  addRevision: (revision: RevisionEntry) => void;
  removeRevision: (index: number) => void;

  // Scale Bar Actions
  updateScaleBar: (updates: Partial<ScaleBarConfig>) => void;
  toggleScaleBar: () => void;
  autoCalculateScaleBar: () => void;

  // North Arrow Actions
  updateNorthArrow: (updates: Partial<NorthArrowConfig>) => void;
  toggleNorthArrow: () => void;

  // Panel Visibility
  setSheetPanelVisible: (visible: boolean) => void;
  toggleSheetPanel: () => void;
  setTitleBlockEditorVisible: (visible: boolean) => void;
  toggleTitleBlockEditor: () => void;

  // Template Management
  saveAsTemplate: (name: string) => void;
  loadTemplate: (templateId: string) => void;
  deleteTemplate: (templateId: string) => void;

  // Auto-populate from model metadata
  autoPopulateTitleBlock: (metadata: Record<string, unknown>) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function createDefaultSheet(options?: SheetCreationOptions): DrawingSheet {
  const paper = PAPER_SIZE_REGISTRY[options?.paperId || 'A3_LANDSCAPE'];
  const frameStyle = (options?.frameStyle || 'professional') as FrameStyle;
  const framePreset = FRAME_PRESETS[frameStyle];
  const titleBlockLayout = (options?.titleBlockLayout || 'standard') as TitleBlockLayout;
  const titleBlockPreset = TITLE_BLOCK_PRESETS[titleBlockLayout];
  const scale = options?.scale || COMMON_SCALES.find((s) => s.factor === 100) || COMMON_SCALES[6];

  const frame = { style: frameStyle, ...framePreset };
  const titleBlock = {
    ...titleBlockPreset,
    fields: DEFAULT_TITLE_BLOCK_FIELDS.map((f) => ({ ...f })),
    logo: null,
  };

  const viewportBounds = calculateViewportBounds(paper, frame, titleBlock);

  return {
    id: `sheet-${Date.now()}`,
    name: 'Drawing Sheet',
    paper,
    frame,
    titleBlock,
    scaleBar: {
      ...DEFAULT_SCALE_BAR,
      totalLengthM: calculateOptimalScaleBarLength(scale.factor, viewportBounds.width * 0.3),
    },
    scale,
    northArrow: { ...DEFAULT_NORTH_ARROW },
    viewportBounds,
    revisions: [],
  };
}

function getDefaultState(): SheetState {
  return {
    activeSheet: null,
    sheetEnabled: false,
    sheetPanelVisible: false,
    titleBlockEditorVisible: false,
    savedSheetTemplates: [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SLICE CREATOR
// ═══════════════════════════════════════════════════════════════════════════

export const createSheetSlice: StateCreator<SheetSlice, [], [], SheetSlice> = (
  set,
  get
) => ({
  // Initial state
  ...getDefaultState(),

  // ═══════════════════════════════════════════════════════════════════════════
  // SHEET ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  createSheet: (options) => {
    const sheet = createDefaultSheet(options);
    set({ activeSheet: sheet, sheetEnabled: true });
  },

  updateSheet: (updates) => {
    const current = get().activeSheet;
    if (!current) return;
    set({ activeSheet: { ...current, ...updates } });
  },

  // `clearSheet` resets the *active* sheet/panel state, not the user's
  // saved template library. `getDefaultState()` also seeds the store's
  // initial state (which correctly starts with no templates), so it can't
  // be reused verbatim here without wiping `savedSheetTemplates` on every
  // "clear" click.
  clearSheet: () =>
    set((s) => ({ ...getDefaultState(), savedSheetTemplates: s.savedSheetTemplates })),

  setSheetEnabled: (enabled) => {
    if (enabled && !get().activeSheet) {
      get().createSheet();
    }
    set({ sheetEnabled: enabled });
  },

  toggleSheetEnabled: () => {
    const current = get().sheetEnabled;
    get().setSheetEnabled(!current);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PAPER/FRAME ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  setPaperSize: (paperId) => {
    const current = get().activeSheet;
    if (!current) return;
    const paper = PAPER_SIZE_REGISTRY[paperId];
    if (!paper) return;

    const viewportBounds = calculateViewportBounds(
      paper,
      current.frame,
      current.titleBlock
    );
    set({
      activeSheet: {
        ...current,
        paper,
        viewportBounds,
      },
    });
  },

  setFrameStyle: (style) => {
    const current = get().activeSheet;
    if (!current) return;
    const preset = FRAME_PRESETS[style];
    if (!preset) return;

    const frame = { style, ...preset };
    const viewportBounds = calculateViewportBounds(
      current.paper,
      frame,
      current.titleBlock
    );
    set({
      activeSheet: {
        ...current,
        frame,
        viewportBounds,
      },
    });
  },

  updateFrameMargins: (margins) => {
    const current = get().activeSheet;
    if (!current) return;

    const frame = {
      ...current.frame,
      margins: { ...current.frame.margins, ...margins },
    };
    const viewportBounds = calculateViewportBounds(
      current.paper,
      frame,
      current.titleBlock
    );
    set({
      activeSheet: {
        ...current,
        frame,
        viewportBounds,
      },
    });
  },

  setDrawingScale: (scale) => {
    const current = get().activeSheet;
    if (!current) return;

    // Auto-recalculate scale bar when scale changes
    const optimalLength = calculateOptimalScaleBarLength(
      scale.factor,
      current.viewportBounds.width * 0.3
    );

    set({
      activeSheet: {
        ...current,
        scale,
        scaleBar: {
          ...current.scaleBar,
          totalLengthM: optimalLength,
        },
      },
    });

    // Update scale field in title block
    get().updateTitleBlockField('scale', `1:${scale.factor}`);
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TITLE BLOCK ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  setTitleBlockLayout: (layout) => {
    const current = get().activeSheet;
    if (!current) return;
    const preset = TITLE_BLOCK_PRESETS[layout];
    if (!preset) return;

    const titleBlock = {
      ...current.titleBlock,
      ...preset,
    };
    const viewportBounds = calculateViewportBounds(
      current.paper,
      current.frame,
      titleBlock
    );
    set({
      activeSheet: {
        ...current,
        titleBlock,
        viewportBounds,
      },
    });
  },

  updateTitleBlockField: (fieldId, value) => {
    const current = get().activeSheet;
    if (!current) return;

    const fields = current.titleBlock.fields.map((f) =>
      f.id === fieldId ? { ...f, value } : f
    );
    set({
      activeSheet: {
        ...current,
        titleBlock: { ...current.titleBlock, fields },
      },
    });
  },

  addTitleBlockField: (field) => {
    const current = get().activeSheet;
    if (!current) return;

    set({
      activeSheet: {
        ...current,
        titleBlock: {
          ...current.titleBlock,
          fields: [...current.titleBlock.fields, field],
        },
      },
    });
  },

  removeTitleBlockField: (fieldId) => {
    const current = get().activeSheet;
    if (!current) return;

    set({
      activeSheet: {
        ...current,
        titleBlock: {
          ...current.titleBlock,
          fields: current.titleBlock.fields.filter((f) => f.id !== fieldId),
        },
      },
    });
  },

  setTitleBlockLogo: (logo) => {
    const current = get().activeSheet;
    if (!current) return;

    set({
      activeSheet: {
        ...current,
        titleBlock: { ...current.titleBlock, logo },
      },
    });
  },

  addRevision: (revision) => {
    const current = get().activeSheet;
    if (!current) return;

    set({
      activeSheet: {
        ...current,
        revisions: [revision, ...current.revisions],
      },
    });
  },

  removeRevision: (index) => {
    const current = get().activeSheet;
    if (!current) return;

    set({
      activeSheet: {
        ...current,
        revisions: current.revisions.filter((_, i) => i !== index),
      },
    });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // SCALE BAR ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  updateScaleBar: (updates) => {
    const current = get().activeSheet;
    if (!current) return;

    set({
      activeSheet: {
        ...current,
        scaleBar: { ...current.scaleBar, ...updates },
      },
    });
  },

  toggleScaleBar: () => {
    const current = get().activeSheet;
    if (!current) return;

    set({
      activeSheet: {
        ...current,
        scaleBar: { ...current.scaleBar, visible: !current.scaleBar.visible },
      },
    });
  },

  autoCalculateScaleBar: () => {
    const current = get().activeSheet;
    if (!current) return;

    const maxLength = current.viewportBounds.width * 0.3;
    const optimalLength = calculateOptimalScaleBarLength(
      current.scale.factor,
      maxLength
    );

    set({
      activeSheet: {
        ...current,
        scaleBar: { ...current.scaleBar, totalLengthM: optimalLength },
      },
    });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // NORTH ARROW ACTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  updateNorthArrow: (updates) => {
    const current = get().activeSheet;
    if (!current) return;

    set({
      activeSheet: {
        ...current,
        northArrow: { ...current.northArrow, ...updates },
      },
    });
  },

  toggleNorthArrow: () => {
    const current = get().activeSheet;
    if (!current) return;

    const newStyle = current.northArrow.style === 'none' ? 'simple' : 'none';
    set({
      activeSheet: {
        ...current,
        northArrow: { ...current.northArrow, style: newStyle },
      },
    });
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // PANEL VISIBILITY
  // ═══════════════════════════════════════════════════════════════════════════

  setSheetPanelVisible: (visible) => set({ sheetPanelVisible: visible }),
  toggleSheetPanel: () =>
    set((s) => ({ sheetPanelVisible: !s.sheetPanelVisible })),
  setTitleBlockEditorVisible: (visible) =>
    set({ titleBlockEditorVisible: visible }),
  toggleTitleBlockEditor: () =>
    set((s) => ({ titleBlockEditorVisible: !s.titleBlockEditorVisible })),

  // ═══════════════════════════════════════════════════════════════════════════
  // TEMPLATE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  saveAsTemplate: (name) => {
    const current = get().activeSheet;
    if (!current) return;

    const template: DrawingSheet = {
      ...current,
      id: `template-${Date.now()}`,
      name,
    };
    set((s) => ({
      savedSheetTemplates: [...s.savedSheetTemplates, template],
    }));
  },

  loadTemplate: (templateId) => {
    const template = get().savedSheetTemplates.find(
      (t) => t.id === templateId
    );
    if (!template) return;

    set({
      activeSheet: { ...template, id: `sheet-${Date.now()}` },
      sheetEnabled: true,
    });
  },

  deleteTemplate: (templateId) => {
    set((s) => ({
      savedSheetTemplates: s.savedSheetTemplates.filter(
        (t) => t.id !== templateId
      ),
    }));
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // AUTO-POPULATE
  // ═══════════════════════════════════════════════════════════════════════════

  autoPopulateTitleBlock: (metadata) => {
    const current = get().activeSheet;
    if (!current) return;

    const fields = current.titleBlock.fields.map((field) => {
      if (!field.autoPopulate || !field.autoPopulateSource) return field;

      // Handle special sources
      if (field.autoPopulateSource === 'date.today') {
        return { ...field, value: new Date().toLocaleDateString() };
      }

      if (field.autoPopulateSource === 'drawing.scale') {
        return { ...field, value: `1:${current.scale.factor}` };
      }

      // Navigate metadata path
      const path = field.autoPopulateSource.split('.');
      let value: unknown = metadata;
      for (const key of path) {
        if (value && typeof value === 'object' && key in value) {
          value = (value as Record<string, unknown>)[key];
        } else {
          value = undefined;
          break;
        }
      }

      if (typeof value === 'string') {
        return { ...field, value };
      }
      return field;
    });

    set({
      activeSheet: {
        ...current,
        titleBlock: { ...current.titleBlock, fields },
      },
    });
  },
});
