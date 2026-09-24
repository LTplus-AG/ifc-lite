/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Drawing panel's inspector column (#5495): Overrides / Sheet / Underlays
 * / Scan as tabs beside the canvas, replacing three view-local `useState`
 * flags plus the store's `sheetPanelVisible`. One tab id is the single
 * source of truth for which settings panel shows; `sheetPanelVisible` (which
 * has its own readers — the Esc double-press handler, `sheetSlice.teardown`)
 * is kept in step with it by `registerDrawingInspectorSheetSync` in
 * `store/index.ts`, not written here.
 *
 * Persistence mirrors the sidebar layout (#1208): a cross-file workspace
 * preference in localStorage, intentionally NOT cleared on a new file load
 * (only the Sheet tab, mirrored through `sheetPanelVisible`, closes with the
 * sheet itself via the sync above).
 */

import type { StateCreator } from 'zustand';

export type DrawingInspectorTab = 'overrides' | 'sheet' | 'underlays' | 'scan';

const TAB_IDS: ReadonlySet<string> = new Set<DrawingInspectorTab>(['overrides', 'sheet', 'underlays', 'scan']);
const STORAGE_KEY = 'ifc-lite:drawing-inspector-v1';

/** Matches the settings drawers' previous fixed `w-72`. */
const DEFAULT_WIDTH = 288;
/** Narrower than this and the container-query tab labels (`.properties-tabs-list`,
 *  240px breakpoint) collapse to icons before the column itself gets useless. */
const MIN_WIDTH = 240;
/** Wide enough for the DXF underlay placement grid's two number-field columns
 *  without the column dominating the canvas. */
const MAX_WIDTH = 480;

function clampWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, px));
}

function isTab(v: unknown): v is DrawingInspectorTab {
  return typeof v === 'string' && TAB_IDS.has(v);
}

interface Persisted {
  tab: DrawingInspectorTab | null;
  width: number;
}

function loadPersisted(): Persisted {
  const fallback: Persisted = { tab: null, width: DEFAULT_WIDTH };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      tab: isTab(parsed?.tab) ? parsed.tab : null,
      width: clampWidth(typeof parsed?.width === 'number' ? parsed.width : DEFAULT_WIDTH),
    };
  } catch (error) {
    console.warn('[drawing-inspector] ignoring malformed persisted state:', error);
    return fallback;
  }
}

function persist(snap: Persisted): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch (error) {
    // Quota / private mode — the layout just won't persist this session.
    console.warn('[drawing-inspector] failed to persist state:', error);
  }
}

export interface DrawingInspectorSlice {
  /** Which of Overrides / Sheet / Underlays / Scan is open, or none (the
   *  column is collapsed). Persisted. */
  drawingInspectorTab: DrawingInspectorTab | null;
  /** Column width in px, beside the canvas. Persisted. */
  drawingInspectorWidth: number;

  /** Open a tab; re-selecting the already-open tab collapses the column. */
  toggleDrawingInspectorTab: (tab: DrawingInspectorTab) => void;
  /** Collapse the column regardless of which tab is open. */
  closeDrawingInspector: () => void;
  setDrawingInspectorWidth: (px: number) => void;
}

export const createDrawingInspectorSlice: StateCreator<DrawingInspectorSlice, [], [], DrawingInspectorSlice> = (set, get) => {
  const persisted = loadPersisted();

  const persistCurrent = (patch: Partial<Persisted>) => {
    const s = get();
    persist({
      tab: patch.tab !== undefined ? patch.tab : s.drawingInspectorTab,
      width: patch.width ?? s.drawingInspectorWidth,
    });
  };

  return {
    drawingInspectorTab: persisted.tab,
    drawingInspectorWidth: persisted.width,

    toggleDrawingInspectorTab: (tab) => {
      const next = get().drawingInspectorTab === tab ? null : tab;
      set({ drawingInspectorTab: next });
      persistCurrent({ tab: next });
    },
    closeDrawingInspector: () => {
      set({ drawingInspectorTab: null });
      persistCurrent({ tab: null });
    },
    setDrawingInspectorWidth: (px) => {
      const width = clampWidth(px);
      set({ drawingInspectorWidth: width });
      persistCurrent({ width });
    },
  };
};
