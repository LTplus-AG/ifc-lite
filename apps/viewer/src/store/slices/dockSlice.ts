/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Dockable / floating workspace panels (issues #1200 / #1201).
 *
 * The right slot in `ViewerLayout` shows one workspace panel at a time. This
 * slice adds an orthogonal "float" channel: any workspace panel can be popped
 * out into a draggable, resizable window that can be snapped to a viewport edge
 * (left / right / bottom) or free-floated anywhere — so a coordinator can keep
 * the Information panel open while Compare runs, Solibri-style. The layout
 * (which panels float, their geometry and snap zone) persists to localStorage
 * as a cross-file workspace preference, so it is intentionally NOT cleared by
 * `resetViewerState` on a new file load.
 */

import type { StateCreator } from 'zustand';
import type { WorkspacePanelId } from '@/lib/panels/registry';

/** Where a floating panel is anchored. `free` uses {@link FloatingPanelState.x/y}. */
export type SnapZone = 'free' | 'left' | 'right' | 'bottom';

export interface FloatingPanelState {
  id: WorkspacePanelId;
  snap: SnapZone;
  /** Free-float position (px from the viewport's top-left). */
  x: number;
  y: number;
  /** Width (free + left/right snap) and height (free + bottom snap), px. */
  w: number;
  h: number;
}

const STORAGE_KEY = 'ifc-lite:dock-layout-v1';

/** Default geometry for a newly floated panel, fanned out so successive
 *  pop-outs don't stack exactly on top of each other. */
function defaultRect(index: number): { x: number; y: number; w: number; h: number } {
  const offset = (index % 5) * 28;
  return { x: 80 + offset, y: 96 + offset, w: 360, h: 460 };
}

function loadPersisted(): FloatingPanelState[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is FloatingPanelState =>
        p && typeof p.id === 'string' && typeof p.x === 'number' && typeof p.w === 'number',
    );
  } catch {
    return [];
  }
}

function persist(panels: FloatingPanelState[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(panels));
  } catch {
    /* quota / private mode — layout just won't persist */
  }
}

export interface DockSlice {
  /** Floating panels, in z-order (last entry renders on top). */
  floatingPanels: FloatingPanelState[];

  /** Pop a panel out into a floating window (no-op if already floating, but
   *  brings it to the front). */
  floatPanel: (id: WorkspacePanelId) => void;
  /** Remove a panel from the floating set (the panel is closed). */
  closeFloatingPanel: (id: WorkspacePanelId) => void;
  /** Update a floating panel's free geometry (drag / resize). */
  setFloatingPanelRect: (id: WorkspacePanelId, rect: Partial<Pick<FloatingPanelState, 'x' | 'y' | 'w' | 'h'>>) => void;
  /** Snap a floating panel to an edge, or free-float it. */
  snapFloatingPanel: (id: WorkspacePanelId, snap: SnapZone) => void;
  /** Raise a floating panel above the others (on focus / pointer-down). */
  bringFloatingPanelToFront: (id: WorkspacePanelId) => void;
  /** Drop every floating panel back to the docked layout. */
  resetDockLayout: () => void;
}

export const createDockSlice: StateCreator<DockSlice, [], [], DockSlice> = (set, get) => ({
  floatingPanels: loadPersisted(),

  floatPanel: (id) => {
    const current = get().floatingPanels;
    const existing = current.find((p) => p.id === id);
    let next: FloatingPanelState[];
    if (existing) {
      // Already floating — just raise it.
      next = [...current.filter((p) => p.id !== id), existing];
    } else {
      const rect = defaultRect(current.length);
      next = [...current, { id, snap: 'free', ...rect }];
    }
    persist(next);
    set({ floatingPanels: next });
  },

  closeFloatingPanel: (id) => {
    const next = get().floatingPanels.filter((p) => p.id !== id);
    persist(next);
    set({ floatingPanels: next });
  },

  setFloatingPanelRect: (id, rect) => {
    const next = get().floatingPanels.map((p) => (p.id === id ? { ...p, ...rect } : p));
    persist(next);
    set({ floatingPanels: next });
  },

  snapFloatingPanel: (id, snap) => {
    const next = get().floatingPanels.map((p) => (p.id === id ? { ...p, snap } : p));
    persist(next);
    set({ floatingPanels: next });
  },

  bringFloatingPanelToFront: (id) => {
    const current = get().floatingPanels;
    const target = current.find((p) => p.id === id);
    if (!target || current[current.length - 1]?.id === id) return;
    const next = [...current.filter((p) => p.id !== id), target];
    persist(next);
    set({ floatingPanels: next });
  },

  resetDockLayout: () => {
    persist([]);
    set({ floatingPanels: [] });
  },
});
