/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Overlay layer registry — P4 of the 4D refactor plan.
 *
 * Problem this solves: multiple subsystems (4D animation, Gantt selection,
 * lens colouring, user isolation) all want to contribute visibility +
 * colour overrides to the viewport. Before this slice each owner wrote
 * directly into `visibilitySlice.hiddenEntities` / `dataSlice.pendingColorUpdates`
 * and tracked "what I added" in a local ref so it could restore on unmount.
 * That pattern was copy-pasted four times with subtly different ownership
 * semantics — a ticking time bomb when a user 3D-click lands between two
 * owners' writes and nobody knows who owns what.
 *
 * Now: each owner registers a named `OverlayLayer` with a priority. The
 * slice composes all active layers (higher priority wins on collisions)
 * and exposes the composite via selectors. Consumers subscribe to the
 * composite and apply it to the renderer in one place.
 *
 * This PR migrates the animation owner. Gantt-selection, lens, and user-
 * isolation continue to write directly for now — they'll move in a follow-up
 * once the animation migration proves the contract.
 */

import type { StateCreator } from 'zustand';

/**
 * RGBA tuple — `[r, g, b, a]` in 0..1 floats. Matches the shape of
 * `pendingColorUpdates` values in `dataSlice` and the animator palette
 * so layers can pass colour values straight through without conversion.
 */
export type RGBA = [number, number, number, number];

export interface OverlayLayer {
  /** Stable id used to register / update / remove. e.g. 'animation'. */
  id: string;
  /**
   * Higher priority wins on colour collisions and determines layering
   * order. Convention (0-1000):
   *   50   — lens (background colouring)
   *   100  — animation
   *   200  — gantt selection
   *   300  — user isolation (visibility wins)
   */
  priority: number;
  /**
   * Local-space expressIds this layer wants hidden. `null` = no
   * visibility contribution.
   */
  hiddenIds: Set<number> | null;
  /**
   * Per-expressId colour override. `null` or empty Map = no colour
   * contribution. Keys are local expressIds (federation translation is
   * the consumer's responsibility at the compose boundary).
   */
  colorOverrides: Map<number, RGBA> | null;
}

export interface OverlaySlice {
  /**
   * Active overlay layers keyed by id. Set-identity is replaced on
   * every update so Zustand's shallow-compare fires for subscribers.
   */
  overlayLayers: Map<string, OverlayLayer>;

  /**
   * Register or replace a layer. Same-id calls overwrite — callers can
   * treat this as the "upsert" primitive: write your layer's current
   * desired state every render, the slice handles the rest.
   */
  registerOverlayLayer: (layer: OverlayLayer) => void;

  /**
   * Remove a layer by id. Idempotent — no-op when the id is unknown.
   * Use on hook cleanup / feature toggle-off.
   */
  removeOverlayLayer: (id: string) => void;

  /**
   * Composite the current layers into flat `hiddenIds` + `colorOverrides`
   * maps. `hiddenIds`: union of every layer's hiddenIds. `colorOverrides`:
   * per-id the highest-priority layer's colour wins.
   *
   * Selector form so callers can memoize via `useViewerStore(computeComposite)`.
   */
  computeCompositeOverlay: () => {
    hiddenIds: Set<number>;
    colorOverrides: Map<number, RGBA>;
  };
}

export const createOverlaySlice: StateCreator<OverlaySlice, [], [], OverlaySlice> = (set, get) => ({
  overlayLayers: new Map(),

  registerOverlayLayer: (layer) => {
    set((s) => {
      const next = new Map(s.overlayLayers);
      next.set(layer.id, layer);
      return { overlayLayers: next };
    });
  },

  removeOverlayLayer: (id) => {
    set((s) => {
      if (!s.overlayLayers.has(id)) return {};
      const next = new Map(s.overlayLayers);
      next.delete(id);
      return { overlayLayers: next };
    });
  },

  computeCompositeOverlay: () => composeLayers(get().overlayLayers),
});

/**
 * Pure compositor — exported so it can be unit-tested in isolation and
 * consumed from places that don't have the store handle (e.g. an adapter
 * that already has the raw layers Map).
 *
 * Algorithm:
 *   1. `hiddenIds`: union of every layer's hiddenIds. No priority needed —
 *      any layer saying "hide this" wins over any layer saying "show it"
 *      (there's no such thing as an explicit "show" in this model; layers
 *      contribute only hide + colour).
 *   2. `colorOverrides`: sort layers by ascending priority and apply each
 *      layer's colour map on top. The final pass's value wins on
 *      collisions, so the highest-priority layer dictates the colour.
 */
export function composeLayers(layers: Map<string, OverlayLayer>): {
  hiddenIds: Set<number>;
  colorOverrides: Map<number, RGBA>;
} {
  const hiddenIds = new Set<number>();
  const colorOverrides = new Map<number, RGBA>();
  if (layers.size === 0) return { hiddenIds, colorOverrides };

  // Ascending priority order — later layers overwrite earlier ones on
  // colour collisions, so the higher-priority layer wins.
  const sorted = Array.from(layers.values()).sort((a, b) => a.priority - b.priority);
  for (const layer of sorted) {
    if (layer.hiddenIds) {
      for (const id of layer.hiddenIds) hiddenIds.add(id);
    }
    if (layer.colorOverrides) {
      for (const [id, rgba] of layer.colorOverrides) colorOverrides.set(id, rgba);
    }
  }
  return { hiddenIds, colorOverrides };
}
