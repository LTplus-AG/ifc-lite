/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * State for the Split tool.
 *
 * Single-element flow today: user hovers a wall, the overlay
 * projects the cursor onto the wall's axis to compute a candidate
 * cut distance, click commits via `MutationSlice.splitWallAtDistance`.
 *
 * Bigger surface (slab cut-line, multi-element plane split, beam /
 * column / member) is in `docs/design/element-splitting.md` and
 * arrives in subsequent phases. The slice is shaped to grow without
 * a breaking rename — `splitMode` covers the future modes;
 * `splitHoverPoint` and `splitTargetExpressId` will be reused.
 */

import type { StateCreator } from 'zustand';

export type SplitMode = 'idle' | 'aiming';

export interface SplitToolSlice {
  /** Tool state machine. `'idle'` while the cursor isn't over a
   * splittable element; `'aiming'` while a preview cut is live. */
  splitMode: SplitMode;
  /** Federated model id that owns the hovered target. */
  splitTargetModelId: string | null;
  /** Express id of the hovered wall. */
  splitTargetExpressId: number | null;
  /**
   * Cursor in storey-local IFC space (Z-up). The overlay reads
   * this to drive a per-frame preview without trampolining through
   * camera projection.
   */
  splitHoverPoint: [number, number, number] | null;
  /**
   * Cached projection from the last hover update — distance along
   * the wall axis from start. Single source of truth for both the
   * SVG preview label and the commit handler.
   */
  splitHoverDistance: number | null;
  /** Total length of the hovered wall (for the "1.42 / 3.50 m" label). */
  splitHoverLength: number | null;
  /** Cut point in storey-local space, derived from distance + wall axis. */
  splitHoverCutPoint: [number, number, number] | null;

  setSplitTarget: (modelId: string | null, expressId: number | null) => void;
  setSplitHover: (
    hoverPoint: [number, number, number] | null,
    distance: number | null,
    length: number | null,
    cutPoint: [number, number, number] | null,
  ) => void;
  clearSplitHover: () => void;
}

export const createSplitToolSlice: StateCreator<SplitToolSlice, [], [], SplitToolSlice> = (set) => ({
  splitMode: 'idle',
  splitTargetModelId: null,
  splitTargetExpressId: null,
  splitHoverPoint: null,
  splitHoverDistance: null,
  splitHoverLength: null,
  splitHoverCutPoint: null,

  setSplitTarget: (modelId, expressId) =>
    set({
      splitTargetModelId: modelId,
      splitTargetExpressId: expressId,
      // Entering / leaving a target without a hover yet means we're
      // back to 'idle'. The setSplitHover call below promotes us to
      // 'aiming' once a preview lands.
      splitMode: 'idle',
      splitHoverPoint: null,
      splitHoverDistance: null,
      splitHoverLength: null,
      splitHoverCutPoint: null,
    }),
  setSplitHover: (hoverPoint, distance, length, cutPoint) =>
    set({
      splitHoverPoint: hoverPoint,
      splitHoverDistance: distance,
      splitHoverLength: length,
      splitHoverCutPoint: cutPoint,
      splitMode: hoverPoint !== null ? 'aiming' : 'idle',
    }),
  clearSplitHover: () =>
    set({
      splitMode: 'idle',
      splitTargetModelId: null,
      splitTargetExpressId: null,
      splitHoverPoint: null,
      splitHoverDistance: null,
      splitHoverLength: null,
      splitHoverCutPoint: null,
    }),
});
