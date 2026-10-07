/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unified workspace sidebar (#1208 follow-up).
 *
 * The right region of the viewer is a VS Code-style **activity bar + docked
 * sidebar**. This slice owns the *layout* of that sidebar — which panels
 * appear in the activity bar, in what order, whether the sidebar is
 * expanded / collapsed-to-icons / hidden, and how wide it is. The *which
 * panel is showing* question is answered by the per-panel visibility flags
 * (kept mutually exclusive by a store subscription in `store/index.ts`),
 * mirrored here as the runtime-only `sidebarActivePanel`.
 *
 * Persistence: the customizable layout (mode / width / order / hidden set)
 * is a cross-file workspace preference saved to localStorage, so — like the
 * dock layout (#1201) — it is intentionally NOT cleared on a new file load.
 * It can additionally be captured into / restored from a Flavor via
 * {@link SidebarSlice.serializeSidebarLayout} / {@link SidebarSlice.applySidebarLayout}.
 */

import type { StateCreator } from 'zustand';
import { getPanelDef, SIDEBAR_DEFAULT_WIDTH_PCT, type WorkspacePanelId } from '@/lib/panels/registry';
import {
  DEFAULT_SIDEBAR_ORDER,
  SIDEBAR_LAYOUT_VERSION,
  clampSidebarWidth,
  migrateSidebarLayout,
  type LayoutChange,
  type PreservedPlacement,
  type SidebarLayoutSnapshot,
  type StoredSidebarLayout,
  type SidebarMode,
} from '@/lib/panels/layout-migration';
import { clearLayoutNotice, loadSidebarLayout, queueLayoutChanges, writeSidebarLayout } from '@/lib/panels/layout-persistence';

export type { SidebarLayoutSnapshot, SidebarMode } from '@/lib/panels/layout-migration';

/** Clamp the docked-split ratio so neither half can collapse to nothing. */
const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;
function clampSplitRatio(r: number): number {
  if (!Number.isFinite(r)) return 0.5;
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, r));
}

/** Only right-pane (`side`) panels can share the docked split (#1266); bottom
 *  and left panels have their own regions. */
function canShareSplit(id: WorkspacePanelId): boolean {
  return getPanelDef(id)?.region === 'side';
}

export interface SidebarSlice {
  /** expanded | collapsed (icons only) | hidden (off). Persisted. */
  sidebarMode: SidebarMode;
  /** Docked sidebar width as a % of the viewport. Persisted. */
  sidebarWidthPct: number;
  /** Activity-bar order of every panel id. Persisted. */
  sidebarOrder: WorkspacePanelId[];
  /** Panels removed from the activity bar (never includes `properties`). Persisted. */
  sidebarHiddenIds: WorkspacePanelId[];
  /** Customize ("edit the bar") mode — runtime only, never persisted. */
  sidebarCustomizing: boolean;
  /** The panel currently shown in the dock — runtime only; tracked from the
   *  per-panel visibility flags by the store subscription. */
  sidebarActivePanel: WorkspacePanelId;
  /** The panel shown in the LOWER half of a split docked pane, or null when the
   *  pane isn't split (#1266). Side panels only; runtime-only (a within-session
   *  power feature, like the float layout's geometry). */
  sidebarSecondaryPanel: WorkspacePanelId | null;
  /** Fraction (0.2 to 0.8) of the docked pane's height given to the TOP panel
   *  when split. Runtime-only. */
  sidebarSplitRatio: number;
  /** Placements this build cannot show (another build's or an extension's
   *  panel), kept verbatim in the persisted layout instead of dropped (#6927). */
  sidebarPreserved: PreservedPlacement[];
  /** Layout changes made by a migration or a profile import, awaiting review
   *  (keep or reset). Persisted until acknowledged. */
  layoutMigrationChanges: LayoutChange[];
  /** Panels currently torn off into an OS / PiP window — runtime only
   *  (window handles can't persist, and pop-up blockers forbid auto-reopen). */
  poppedOutIds: WorkspacePanelId[];

  setSidebarMode: (mode: SidebarMode) => void;
  /** Off ⇄ on (expanded). The "is the sidebar optional" toggle. */
  toggleSidebar: () => void;
  /** expanded → collapsed → hidden → expanded. */
  cycleSidebarMode: () => void;
  setSidebarWidthPct: (pct: number) => void;
  /** Move a panel to a new index within the activity-bar order. */
  reorderSidebarPanel: (id: WorkspacePanelId, toIndex: number) => void;
  /** Show / hide a panel in the activity bar (`properties` always shows). */
  setPanelShownInSidebar: (id: WorkspacePanelId, shown: boolean) => void;
  setSidebarCustomizing: (on: boolean) => void;
  /** Restore order / hidden / width / mode to the shipped defaults. */
  resetSidebarLayout: () => void;
  /** Set the active docked panel (called by the store's exclusivity subscription). */
  setSidebarActivePanel: (id: WorkspacePanelId) => void;
  /** Set / clear the lower-half split panel (#1266). Ignores non-side panels and
   *  a panel that already owns the top half. Un-floating is the caller's job. */
  setSidebarSecondaryPanel: (id: WorkspacePanelId | null) => void;
  /** Resize the docked split (fraction for the top panel, clamped 0.2 to 0.8). */
  setSidebarSplitRatio: (ratio: number) => void;
  /** Track a panel popped out into / re-docked from an OS window. */
  setPanelPoppedOut: (id: WorkspacePanelId, on: boolean) => void;

  /** Capture the customizable layout (for a Flavor's `layout.state.sidebar`). */
  serializeSidebarLayout: () => StoredSidebarLayout;
  /** Apply a captured layout (from a Flavor). Persists + tolerates garbage.
   *  Returns what the migration changed, which also joins the review notice. */
  applySidebarLayout: (snap: unknown) => LayoutChange[];
  /** Keep the migrated layout: clears the review notice (backups stay). */
  acknowledgeLayoutMigration: () => void;
}

export const createSidebarSlice: StateCreator<SidebarSlice, [], [], SidebarSlice> = (set, get) => {
  const { layout: persisted, pending } = loadSidebarLayout();

  /** Persist the layout fields plus preserved placements, reading the rest from state. */
  const persistCurrent = (patch: Partial<SidebarLayoutSnapshot>) => {
    const s = get();
    writeSidebarLayout({
      version: SIDEBAR_LAYOUT_VERSION,
      mode: patch.mode ?? s.sidebarMode,
      widthPct: patch.widthPct ?? s.sidebarWidthPct,
      order: patch.order ?? s.sidebarOrder,
      hiddenIds: patch.hiddenIds ?? s.sidebarHiddenIds,
      preserved: s.sidebarPreserved,
    });
  };

  return {
    sidebarMode: persisted.mode,
    sidebarWidthPct: persisted.widthPct,
    sidebarOrder: persisted.order,
    sidebarHiddenIds: persisted.hiddenIds,
    sidebarPreserved: persisted.preserved,
    layoutMigrationChanges: pending,
    sidebarCustomizing: false,
    sidebarActivePanel: 'properties',
    sidebarSecondaryPanel: null,
    sidebarSplitRatio: 0.5,
    poppedOutIds: [],

    setSidebarMode: (mode) => {
      // Leaving expanded mode hides the activity bar / content pane, so the
      // customize popover would be stranded with no UI — exit customize too.
      set({ sidebarMode: mode, sidebarCustomizing: mode === 'expanded' ? get().sidebarCustomizing : false });
      persistCurrent({ mode });
    },

    toggleSidebar: () => {
      get().setSidebarMode(get().sidebarMode === 'expanded' ? 'collapsed' : 'expanded');
    },

    cycleSidebarMode: () => {
      get().setSidebarMode(get().sidebarMode === 'expanded' ? 'collapsed' : 'expanded');
    },

    setSidebarWidthPct: (pct) => {
      const widthPct = clampSidebarWidth(pct);
      set({ sidebarWidthPct: widthPct });
      persistCurrent({ widthPct });
    },

    reorderSidebarPanel: (id, toIndex) => {
      const order = [...get().sidebarOrder];
      const from = order.indexOf(id);
      if (from === -1) return;
      order.splice(from, 1);
      const clamped = Math.max(0, Math.min(order.length, toIndex));
      order.splice(clamped, 0, id);
      set({ sidebarOrder: order });
      persistCurrent({ order });
    },

    setPanelShownInSidebar: (id, shown) => {
      if (id === 'properties') return; // the fallback always shows
      const hiddenIds = new Set(get().sidebarHiddenIds);
      if (shown) hiddenIds.delete(id);
      else hiddenIds.add(id);
      const next = [...hiddenIds];
      set({ sidebarHiddenIds: next });
      persistCurrent({ hiddenIds: next });
    },

    setSidebarCustomizing: (on) => set({ sidebarCustomizing: on }),

    resetSidebarLayout: () => {
      const snap: SidebarLayoutSnapshot = {
        mode: 'expanded',
        widthPct: SIDEBAR_DEFAULT_WIDTH_PCT,
        order: [...DEFAULT_SIDEBAR_ORDER],
        hiddenIds: [],
      };
      set({
        sidebarMode: snap.mode,
        sidebarWidthPct: snap.widthPct,
        sidebarOrder: snap.order,
        sidebarHiddenIds: snap.hiddenIds,
        sidebarCustomizing: false,
        // Drop any docked split back to a single panel (#1266).
        sidebarSecondaryPanel: null,
        sidebarSplitRatio: 0.5,
        // A reset answers the review notice; preserved placements stay stored.
        layoutMigrationChanges: [],
      });
      clearLayoutNotice();
      writeSidebarLayout({ ...snap, version: SIDEBAR_LAYOUT_VERSION, preserved: get().sidebarPreserved });
    },

    setSidebarActivePanel: (id) => {
      const patch: Partial<SidebarSlice> = {};
      if (get().sidebarActivePanel !== id) patch.sidebarActivePanel = id;
      // The top half can't also be the bottom half: if the new primary is the
      // split secondary, collapse the split (#1266).
      if (get().sidebarSecondaryPanel === id) patch.sidebarSecondaryPanel = null;
      if (Object.keys(patch).length > 0) set(patch);
    },

    setSidebarSecondaryPanel: (id) => {
      if (id !== null && (!canShareSplit(id) || id === get().sidebarActivePanel)) return;
      set({ sidebarSecondaryPanel: id });
    },

    setSidebarSplitRatio: (ratio) => set({ sidebarSplitRatio: clampSplitRatio(ratio) }),

    setPanelPoppedOut: (id, on) => {
      const current = get().poppedOutIds;
      const has = current.includes(id);
      if (on && !has) set({ poppedOutIds: [...current, id] });
      else if (!on && has) set({ poppedOutIds: current.filter((x) => x !== id) });
    },

    serializeSidebarLayout: () => {
      const s = get();
      return {
        version: SIDEBAR_LAYOUT_VERSION,
        mode: s.sidebarMode,
        widthPct: s.sidebarWidthPct,
        order: [...s.sidebarOrder],
        hiddenIds: [...s.sidebarHiddenIds],
        preserved: s.sidebarPreserved.map(placement => ({ ...placement })),
      };
    },

    applySidebarLayout: (snap) => {
      const obj = snap && typeof snap === 'object' ? snap as Record<string, unknown> : {};
      const { layout: next, changes } = migrateSidebarLayout(
        { ...obj, widthPct: typeof obj.widthPct === 'number' ? obj.widthPct : get().sidebarWidthPct },
        get().sidebarMode,
      );
      // A captured layout never erases placements this browser is keeping.
      for (const kept of get().sidebarPreserved) {
        if (!next.preserved.some((p) => p.id === kept.id)) next.preserved.push(kept);
      }
      // Capture the pre-import value before queuing this import's review notice.
      writeSidebarLayout(next, changes.length > 0);
      set({
        sidebarMode: next.mode,
        sidebarWidthPct: next.widthPct,
        sidebarOrder: next.order,
        sidebarHiddenIds: next.hiddenIds,
        sidebarPreserved: next.preserved,
        ...(changes.length > 0 ? { layoutMigrationChanges: queueLayoutChanges(changes) } : {}),
      });
      return changes;
    },

    acknowledgeLayoutMigration: () => {
      clearLayoutNotice();
      set({ layoutMigrationChanges: [] });
    },
  };
};
