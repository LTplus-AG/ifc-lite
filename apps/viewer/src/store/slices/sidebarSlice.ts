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
import {
  WORKSPACE_PANELS,
  isWorkspacePanelId,
  SIDEBAR_DEFAULT_WIDTH_PCT,
  type WorkspacePanelId,
} from '@/lib/panels/registry';

/** Expanded = rail + content pane; collapsed = icon-only rail. The activity-bar
 *  rail is always visible — there is intentionally no "fully off" mode (the
 *  rail is the always-available entry point to every panel). */
export type SidebarMode = 'expanded' | 'collapsed';

/** The portable shape captured into a Flavor's `layout.state.sidebar`. */
export interface SidebarLayoutSnapshot {
  mode: SidebarMode;
  widthPct: number;
  order: WorkspacePanelId[];
  hiddenIds: WorkspacePanelId[];
}

const STORAGE_KEY = 'ifc-lite:sidebar-layout-v1';
const MIN_WIDTH_PCT = 14;
const MAX_WIDTH_PCT = 60;

const DEFAULT_ORDER: WorkspacePanelId[] = WORKSPACE_PANELS.map((p) => p.id);

function clampWidth(pct: number): number {
  if (!Number.isFinite(pct)) return SIDEBAR_DEFAULT_WIDTH_PCT;
  return Math.max(MIN_WIDTH_PCT, Math.min(MAX_WIDTH_PCT, pct));
}

/**
 * Reconcile a possibly-stale persisted order with the live registry: keep the
 * persisted ordering for ids that still exist, drop unknown ids, and append
 * any registry panels the persisted list never knew about (so newly-added
 * panels surface instead of silently vanishing).
 */
function normalizeOrder(order: unknown): WorkspacePanelId[] {
  const seen = new Set<WorkspacePanelId>();
  const out: WorkspacePanelId[] = [];
  if (Array.isArray(order)) {
    for (const id of order) {
      if (typeof id === 'string' && isWorkspacePanelId(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  for (const id of DEFAULT_ORDER) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

/** Information is the always-available fallback — it can never be hidden. */
function normalizeHidden(hidden: unknown): WorkspacePanelId[] {
  if (!Array.isArray(hidden)) return [];
  const out = new Set<WorkspacePanelId>();
  for (const id of hidden) {
    if (typeof id === 'string' && isWorkspacePanelId(id) && id !== 'properties') out.add(id);
  }
  return [...out];
}

function isMode(m: unknown): m is SidebarMode {
  return m === 'expanded' || m === 'collapsed';
}

/** Coerce a persisted / captured mode, migrating the retired `hidden` value to
 *  `collapsed` so the rail stays visible. */
function coerceMode(m: unknown, fallback: SidebarMode): SidebarMode {
  if (isMode(m)) return m;
  if (m === 'hidden') return 'collapsed';
  return fallback;
}

function loadPersisted(): SidebarLayoutSnapshot {
  const fallback: SidebarLayoutSnapshot = {
    mode: 'expanded',
    widthPct: SIDEBAR_DEFAULT_WIDTH_PCT,
    order: [...DEFAULT_ORDER],
    hiddenIds: [],
  };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<SidebarLayoutSnapshot>;
    return {
      mode: coerceMode(parsed?.mode, 'expanded'),
      widthPct: clampWidth(typeof parsed?.widthPct === 'number' ? parsed.widthPct : SIDEBAR_DEFAULT_WIDTH_PCT),
      order: normalizeOrder(parsed?.order),
      hiddenIds: normalizeHidden(parsed?.hiddenIds),
    };
  } catch (error) {
    console.warn('[sidebar] ignoring malformed persisted layout:', error);
    return fallback;
  }
}

function persist(snap: SidebarLayoutSnapshot): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch (error) {
    // Quota / private mode — the layout just won't persist this session.
    console.warn('[sidebar] failed to persist layout:', error);
  }
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
  /** Track a panel popped out into / re-docked from an OS window. */
  setPanelPoppedOut: (id: WorkspacePanelId, on: boolean) => void;

  /** Capture the customizable layout (for a Flavor's `layout.state.sidebar`). */
  serializeSidebarLayout: () => SidebarLayoutSnapshot;
  /** Apply a captured layout (from a Flavor). Persists + tolerates garbage. */
  applySidebarLayout: (snap: unknown) => void;
}

export const createSidebarSlice: StateCreator<SidebarSlice, [], [], SidebarSlice> = (set, get) => {
  const persisted = loadPersisted();

  /** Persist only the four layout fields, reading the rest from current state. */
  const persistCurrent = (patch: Partial<SidebarLayoutSnapshot>) => {
    const s = get();
    persist({
      mode: patch.mode ?? s.sidebarMode,
      widthPct: patch.widthPct ?? s.sidebarWidthPct,
      order: patch.order ?? s.sidebarOrder,
      hiddenIds: patch.hiddenIds ?? s.sidebarHiddenIds,
    });
  };

  return {
    sidebarMode: persisted.mode,
    sidebarWidthPct: persisted.widthPct,
    sidebarOrder: persisted.order,
    sidebarHiddenIds: persisted.hiddenIds,
    sidebarCustomizing: false,
    sidebarActivePanel: 'properties',
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
      const widthPct = clampWidth(pct);
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
        order: [...DEFAULT_ORDER],
        hiddenIds: [],
      };
      set({
        sidebarMode: snap.mode,
        sidebarWidthPct: snap.widthPct,
        sidebarOrder: snap.order,
        sidebarHiddenIds: snap.hiddenIds,
        sidebarCustomizing: false,
      });
      persist(snap);
    },

    setSidebarActivePanel: (id) => {
      if (get().sidebarActivePanel !== id) set({ sidebarActivePanel: id });
    },

    setPanelPoppedOut: (id, on) => {
      const current = get().poppedOutIds;
      const has = current.includes(id);
      if (on && !has) set({ poppedOutIds: [...current, id] });
      else if (!on && has) set({ poppedOutIds: current.filter((x) => x !== id) });
    },

    serializeSidebarLayout: () => {
      const s = get();
      return {
        mode: s.sidebarMode,
        widthPct: s.sidebarWidthPct,
        order: [...s.sidebarOrder],
        hiddenIds: [...s.sidebarHiddenIds],
      };
    },

    applySidebarLayout: (snap) => {
      const obj = (snap ?? {}) as Partial<SidebarLayoutSnapshot>;
      const next: SidebarLayoutSnapshot = {
        mode: coerceMode(obj.mode, get().sidebarMode),
        widthPct: clampWidth(typeof obj.widthPct === 'number' ? obj.widthPct : get().sidebarWidthPct),
        order: normalizeOrder(obj.order),
        hiddenIds: normalizeHidden(obj.hiddenIds),
      };
      set({
        sidebarMode: next.mode,
        sidebarWidthPct: next.widthPct,
        sidebarOrder: next.order,
        sidebarHiddenIds: next.hiddenIds,
      });
      persist(next);
    },
  };
};
