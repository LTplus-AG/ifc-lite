/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pinboard (Basket) state slice
 *
 * The basket is an incremental isolation set. Users can build it from
 * selection / visible scene / hierarchy sources via presentation controls:
 *   = (set)    — replace basket with source set
 *   + (add)    — add source set to basket
 *   − (remove) — remove source set from basket
 *
 * When the basket is non-empty, only basket entities are visible (isolation).
 * The basket also syncs to isolatedEntities for renderer consumption.
 * Users can persist any basket as a saved "view" with a thumbnail preview.
 */

import type { StateCreator } from 'zustand';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import type { CameraCallbacks, CameraViewpoint, EntityRef, SectionPlane } from '../types.js';
import { entityRefToString, stringToEntityRef } from '../types.js';
import { toGlobalIdForRef } from '../globalId.js';

export type BasketSource = 'selection' | 'visible' | 'hierarchy' | 'manual';

export interface BasketSectionSnapshot {
  plane: SectionPlane;
  drawing2D: Drawing2D | null;
  show3DOverlay: boolean;
  showHiddenLines: boolean;
}

export interface BasketView {
  id: string;
  name: string;
  entityRefs: string[];
  thumbnailDataUrl: string | null;
  /** Optional camera transition override for this view (ms). */
  transitionMs: number | null;
  viewpoint: CameraViewpoint | null;
  section: BasketSectionSnapshot | null;
  source: BasketSource;
  createdAt: number;
  updatedAt: number;
}

export interface SaveBasketViewOptions {
  name?: string;
  thumbnailDataUrl?: string | null;
  transitionMs?: number | null;
  source?: BasketSource;
  viewpoint?: CameraViewpoint | null;
  section?: BasketSectionSnapshot | null;
}

/**
 * Cross-slice state that pinboard reads/writes via the combined store.
 *
 * When the basket is non-empty, pinboard owns `isolatedEntities` and
 * `hiddenEntities` — it is the isolation mechanism.  The visibility slice
 * also writes these fields for non-basket isolation (direct UI isolation).
 * They share the same state fields by design.
 */
interface PinboardCrossSliceState {
  isolatedEntities: Set<number> | null;
  hiddenEntities: Set<number>;
  models: Map<string, { idOffset: number }>;
  cameraCallbacks: CameraCallbacks;
  sectionPlane: SectionPlane;
  drawing2D: Drawing2D | null;
  drawing2DDisplayOptions: { show3DOverlay: boolean; showHiddenLines: boolean };
  setDrawing2D: (drawing: Drawing2D | null) => void;
  updateDrawing2DDisplayOptions: (options: { show3DOverlay?: boolean; showHiddenLines?: boolean }) => void;
  setActiveTool: (tool: string) => void;
  clearEntitySelection: () => void;
  activeTool: string;
}

export interface PinboardSlice {
  // State
  /** Serialized EntityRef strings for O(1) membership check */
  pinboardEntities: Set<string>;
  /** Saved basket presets with optional viewport thumbnails */
  basketViews: BasketView[];
  /** Active saved view currently restored into the live basket */
  activeBasketViewId: string | null;
  /** Floating presentation dock visibility */
  basketPresentationVisible: boolean;
  /** Last hierarchy-derived set used for "Hierarchy" basket source */
  hierarchyBasketSelection: Set<string>;

  // Actions
  /** Add entities to pinboard/basket */
  addToPinboard: (refs: EntityRef[]) => void;
  /** Remove entities from pinboard/basket */
  removeFromPinboard: (refs: EntityRef[]) => void;
  /** Replace pinboard/basket contents (= operation) */
  setPinboard: (refs: EntityRef[]) => void;
  /** Clear pinboard/basket and isolation */
  clearPinboard: () => void;
  /** Isolate pinboard entities (sync basket → isolatedEntities) */
  showPinboard: () => void;
  /** Check if entity is in basket */
  isInPinboard: (ref: EntityRef) => boolean;
  /** Get basket count */
  getPinboardCount: () => number;
  /** Get all basket entities as EntityRef array */
  getPinboardEntities: () => EntityRef[];

  // Basket actions (semantic aliases that also sync isolation)
  /** = Set basket to exactly these entities and isolate them */
  setBasket: (refs: EntityRef[]) => void;
  /** + Add entities to basket and update isolation */
  addToBasket: (refs: EntityRef[]) => void;
  /** − Remove entities from basket and update isolation */
  removeFromBasket: (refs: EntityRef[]) => void;
  /** Clear basket and clear isolation */
  clearBasket: () => void;
  /** Set hierarchy-derived basket source */
  setHierarchyBasketSelection: (refs: EntityRef[]) => void;
  /** Clear hierarchy-derived basket source */
  clearHierarchyBasketSelection: () => void;
  /** Show/hide presentation dock */
  setBasketPresentationVisible: (visible: boolean) => void;
  /** Toggle presentation dock */
  toggleBasketPresentationVisible: () => void;
  /** Save current basket as a reusable view preset */
  saveCurrentBasketView: (options?: SaveBasketViewOptions) => string | null;
  /** Restore basket entities and isolation only (no camera/section). Use activateBasketViewFromStore for full restore. */
  restoreBasketEntities: (entityRefs: string[], viewId: string) => void;
  /** Restore a saved basket view into the live basket (delegates to activateBasketViewFromStore) */
  activateBasketView: (viewId: string) => void;
  /** Remove a saved basket view */
  removeBasketView: (viewId: string) => void;
  /** Rename a saved basket view */
  renameBasketView: (viewId: string, name: string) => void;
  /** Refresh thumbnail and viewpoint capture for a saved basket view */
  refreshBasketViewThumbnail: (viewId: string, thumbnailDataUrl: string | null, viewpoint?: CameraViewpoint | null) => void;
  /** Set optional transition duration for a saved basket view (ms). */
  setBasketViewTransitionMs: (viewId: string, transitionMs: number | null) => void;
}

/** Convert basket EntityRefs to global IDs using model offsets */
function basketToGlobalIds(
  basketEntities: Set<string>,
  models: Map<string, { idOffset: number }>,
): Set<number> {
  const globalIds = new Set<number>();
  for (const str of basketEntities) {
    const ref = stringToEntityRef(str);
    globalIds.add(toGlobalIdForRef(models, ref));
  }
  return globalIds;
}

/** Compute a single EntityRef's global ID */
function refToGlobalId(ref: EntityRef, models: Map<string, { idOffset: number }>): number {
  return toGlobalIdForRef(models, ref);
}

function refsToEntityKeySet(refs: EntityRef[]): Set<string> {
  const keys = new Set<string>();
  for (const ref of refs) keys.add(entityRefToString(ref));
  return keys;
}

function entityKeysToRefs(keys: Iterable<string>): EntityRef[] {
  const refs: EntityRef[] = [];
  for (const key of keys) refs.push(stringToEntityRef(key));
  return refs;
}

/**
 * Compute isolation + hidden state from basket entities, unhiding any newly added refs.
 *
 * This is the single source of truth for the "basket → visibility" sync that
 * several pinboard actions need.  The incremental add/remove methods bypass
 * this for performance and maintain their own logic.
 */
function computeBasketVisibility(
  nextBasket: Set<string>,
  models: Map<string, { idOffset: number }>,
  currentHidden: Set<number>,
  unhideRefs?: EntityRef[],
): { isolatedEntities: Set<number> | null; hiddenEntities: Set<number> } {
  if (nextBasket.size === 0) {
    return { isolatedEntities: null, hiddenEntities: currentHidden };
  }
  const isolatedEntities = basketToGlobalIds(nextBasket, models);
  if (!unhideRefs || unhideRefs.length === 0) {
    return { isolatedEntities, hiddenEntities: currentHidden };
  }
  const hiddenEntities = new Set<number>(currentHidden);
  for (const ref of unhideRefs) {
    hiddenEntities.delete(toGlobalIdForRef(models, ref));
  }
  return { isolatedEntities, hiddenEntities };
}

function createViewId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `basket-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function createNextViewName(views: BasketView[]): string {
  let idx = 1;
  const names = new Set(views.map((v) => v.name));
  while (names.has(`Basket ${idx}`)) idx++;
  return `Basket ${idx}`;
}

function captureSectionSnapshot(state: PinboardCrossSliceState): BasketSectionSnapshot | null {
  if (state.activeTool !== 'section' || !state.sectionPlane.enabled) {
    return null;
  }

  return {
    plane: { ...state.sectionPlane },
    // Basket views restore 3D section state only. 2D drawings are derived, mutable,
    // and global in store state; persisting them per-view causes cross-view leakage.
    drawing2D: null,
    show3DOverlay: state.drawing2DDisplayOptions.show3DOverlay,
    showHiddenLines: state.drawing2DDisplayOptions.showHiddenLines,
  };
}

export const createPinboardSlice: StateCreator<
  PinboardSlice & PinboardCrossSliceState,
  [],
  [],
  PinboardSlice
> = (set, get) => ({
  // Initial state
  pinboardEntities: new Set(),
  basketViews: [],
  activeBasketViewId: null,
  basketPresentationVisible: false,
  hierarchyBasketSelection: new Set(),

  // Legacy actions (kept for backward compat, but now they also sync isolation)
  addToPinboard: (refs) => {
    if (refs.length > 0) {
      get().clearEntitySelection();
    }
    set((state) => {
      const next = new Set<string>(state.pinboardEntities);
      for (const ref of refs) {
        next.add(entityRefToString(ref));
      }
      const visibility = computeBasketVisibility(next, state.models, state.hiddenEntities, refs);
      return {
        pinboardEntities: next,
        ...visibility,
        activeBasketViewId: null,
      };
    });
  },

  removeFromPinboard: (refs) => {
    set((state) => {
      const next = new Set<string>(state.pinboardEntities);
      for (const ref of refs) {
        next.delete(entityRefToString(ref));
      }
      if (next.size === 0) {
        return { pinboardEntities: next, isolatedEntities: null, activeBasketViewId: null };
      }
      const isolatedEntities = basketToGlobalIds(next, state.models);
      return { pinboardEntities: next, isolatedEntities, activeBasketViewId: null };
    });
  },

  setPinboard: (refs) => {
    if (refs.length > 0) {
      get().clearEntitySelection();
    }
    const next = new Set<string>();
    for (const ref of refs) {
      next.add(entityRefToString(ref));
    }
    const s = get();
    const visibility = computeBasketVisibility(next, s.models, s.hiddenEntities, refs);
    set({ pinboardEntities: next, ...visibility, activeBasketViewId: null });
  },

  clearPinboard: () => set({ pinboardEntities: new Set(), isolatedEntities: null, activeBasketViewId: null }),

  showPinboard: () => {
    const state = get();
    if (state.pinboardEntities.size === 0) return;
    const isolatedEntities = basketToGlobalIds(state.pinboardEntities, state.models);
    set({ isolatedEntities });
  },

  isInPinboard: (ref) => get().pinboardEntities.has(entityRefToString(ref)),

  getPinboardCount: () => get().pinboardEntities.size,

  getPinboardEntities: () => {
    const result: EntityRef[] = [];
    for (const str of get().pinboardEntities) {
      result.push(stringToEntityRef(str));
    }
    return result;
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Basket actions (= + −)
  // These are the primary API for the new basket-based isolation UX.
  // ──────────────────────────────────────────────────────────────────────────

  /** = Set basket to exactly these entities and isolate them */
  setBasket: (refs) => {
    if (refs.length === 0) {
      set({ pinboardEntities: new Set(), isolatedEntities: null, activeBasketViewId: null });
      return;
    }
    get().clearEntitySelection();
    const next = new Set<string>();
    for (const ref of refs) {
      next.add(entityRefToString(ref));
    }
    const s = get();
    const visibility = computeBasketVisibility(next, s.models, s.hiddenEntities, refs);
    set({ pinboardEntities: next, ...visibility, activeBasketViewId: null });
  },

  /** + Add entities to basket and update isolation (incremental — avoids re-parsing all strings) */
  addToBasket: (refs) => {
    if (refs.length === 0) return;
    get().clearEntitySelection();
    set((state) => {
      const next = new Set<string>(state.pinboardEntities);
      for (const ref of refs) {
        next.add(entityRefToString(ref));
      }
      const hiddenEntities = new Set<number>(state.hiddenEntities);
      // Incrementally add new globalIds to existing isolation set instead of re-parsing all
      const prevIsolated = state.isolatedEntities;
      const isolatedEntities = prevIsolated ? new Set<number>(prevIsolated) : basketToGlobalIds(state.pinboardEntities, state.models);
      for (const ref of refs) {
        const gid = refToGlobalId(ref, state.models);
        isolatedEntities.add(gid);
        hiddenEntities.delete(gid);
      }
      return { pinboardEntities: next, isolatedEntities, hiddenEntities, activeBasketViewId: null };
    });
  },

  /** − Remove entities from basket and update isolation (incremental — avoids re-parsing all strings) */
  removeFromBasket: (refs) => {
    if (refs.length === 0) return;
    set((state) => {
      const next = new Set<string>(state.pinboardEntities);
      for (const ref of refs) {
        next.delete(entityRefToString(ref));
      }
      if (next.size === 0) {
        return { pinboardEntities: next, isolatedEntities: null, activeBasketViewId: null };
      }
      // Incrementally remove globalIds from existing isolation set instead of re-parsing all
      const prevIsolated = state.isolatedEntities;
      if (prevIsolated) {
        const isolatedEntities = new Set<number>(prevIsolated);
        for (const ref of refs) {
          isolatedEntities.delete(refToGlobalId(ref, state.models));
        }
        return { pinboardEntities: next, isolatedEntities, activeBasketViewId: null };
      }
      // Fallback: full recompute if no existing isolation set
      const isolatedEntities = basketToGlobalIds(next, state.models);
      return { pinboardEntities: next, isolatedEntities, activeBasketViewId: null };
    });
  },

  /** Clear basket and clear isolation */
  clearBasket: () => set({ pinboardEntities: new Set(), isolatedEntities: null, activeBasketViewId: null }),

  setHierarchyBasketSelection: (refs) => set({ hierarchyBasketSelection: refsToEntityKeySet(refs) }),
  clearHierarchyBasketSelection: () => set({ hierarchyBasketSelection: new Set() }),

  setBasketPresentationVisible: (basketPresentationVisible) => set({ basketPresentationVisible }),
  toggleBasketPresentationVisible: () =>
    set((state) => ({ basketPresentationVisible: !state.basketPresentationVisible })),

  saveCurrentBasketView: (options) => {
    const state = get();
    if (state.pinboardEntities.size === 0) return null;

    const id = createViewId();
    const now = Date.now();
    const view: BasketView = {
      id,
      name: options?.name?.trim() || createNextViewName(state.basketViews),
      entityRefs: Array.from(state.pinboardEntities),
      thumbnailDataUrl: options?.thumbnailDataUrl ?? null,
      transitionMs: options?.transitionMs ?? null,
      viewpoint: options?.viewpoint ?? state.cameraCallbacks.getViewpoint?.() ?? null,
      section: options?.section ?? captureSectionSnapshot(state),
      source: options?.source ?? 'manual',
      createdAt: now,
      updatedAt: now,
    };

    set((current) => ({
      basketViews: [...current.basketViews, view],
      activeBasketViewId: id,
    }));
    return id;
  },

  restoreBasketEntities: (entityRefs, viewId) => {
    get().clearEntitySelection?.();
    set((current) => {
      const nextPinboard = new Set<string>(entityRefs);
      const refs = entityKeysToRefs(nextPinboard);
      const visibility = computeBasketVisibility(nextPinboard, current.models, current.hiddenEntities, refs);
      return {
        pinboardEntities: nextPinboard.size === 0 ? new Set() : nextPinboard,
        ...visibility,
        activeBasketViewId: viewId,
      };
    });
  },

  activateBasketView: (viewId) => {
    void import('../basket/basketViewActivator.js')
      .then(({ activateBasketViewFromStore }) => {
        activateBasketViewFromStore(viewId);
      })
      // Fire-and-forget: with no handler a rejected chunk load (a deploy rotated
      // the hash under this tab - see lib/chunk-version-skew.ts) becomes an
      // unhandled rejection. The view simply does not activate; the reload the
      // skew handler schedules is the recovery.
      .catch((err) => {
        console.warn('[pinboard] could not load the basket-view activator', err);
      });
  },

  removeBasketView: (viewId) => {
    set((state) => ({
      basketViews: state.basketViews.filter((view) => view.id !== viewId),
      activeBasketViewId: state.activeBasketViewId === viewId ? null : state.activeBasketViewId,
    }));
  },

  renameBasketView: (viewId, name) => {
    const nextName = name.trim();
    if (!nextName) return;
    set((state) => ({
      basketViews: state.basketViews.map((view) =>
        view.id === viewId ? { ...view, name: nextName, updatedAt: Date.now() } : view,
      ),
    }));
  },

  refreshBasketViewThumbnail: (viewId, thumbnailDataUrl, viewpoint) => {
    set((state) => {
      const nextViewpoint = viewpoint === undefined ? state.cameraCallbacks.getViewpoint?.() ?? null : viewpoint;
      return {
        basketViews: state.basketViews.map((view) =>
          view.id === viewId ? { ...view, thumbnailDataUrl, viewpoint: nextViewpoint, updatedAt: Date.now() } : view,
        ),
      };
    });
  },

  setBasketViewTransitionMs: (viewId, transitionMs) => {
    set((state) => ({
      basketViews: state.basketViews.map((view) =>
        view.id === viewId ? { ...view, transitionMs, updatedAt: Date.now() } : view,
      ),
    }));
  },
});
