/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Level display mode — Pascal Editor's Stacked / Exploded / Solo
 * pattern, adapted to ifc-lite's spatial hierarchy.
 *
 *   - Stacked   (default): every storey at its native elevation.
 *   - Exploded            : each storey lifted along world +Y by
 *                           `storey-index × explodedGap`, indexed
 *                           after sorting storeys by elevation
 *                           ascending. Index 0 stays at its
 *                           native Y; subsequent storeys move up
 *                           by `gap`.
 *   - Solo                : only entities in `soloStoreyExpressId`
 *                           render. Driven by the existing
 *                           visibilitySlice.setIsolatedEntities so
 *                           we don't ship a second isolation
 *                           channel.
 *
 * The slice owns mode + parameters only. The actual mesh
 * translation (Exploded) and isolation (Solo) are applied by a
 * separate hook in the viewer — `useLevelDisplayEffect` — which
 * watches the slice and the active model's spatial hierarchy and
 * flushes per-entity updates to the renderer via
 * `pendingMeshTranslations` and `setIsolatedEntities`.
 *
 * Reversibility: the slice keeps the LAST APPLIED offset per
 * storey so the effect can compute the delta between target and
 * applied when the user toggles modes — no "remember the original
 * positions" gymnastics. Switching Exploded → Stacked subtracts
 * the applied offset; switching gap mid-Exploded shifts by the
 * difference.
 */

import type { StateCreator } from 'zustand';

export type LevelDisplayMode = 'stacked' | 'exploded' | 'solo';

/** Per-model snapshot of the currently-applied storey offsets. */
export type AppliedStoreyOffsets = Map<
  string /* modelId */,
  Map<number /* storey express id */, number /* applied Y offset (m, renderer frame) */>
>;

export interface LevelDisplaySlice {
  levelDisplayMode: LevelDisplayMode;
  /** Storey for Solo. Null = first storey of activeModel; the
   * effect picks the first one on activation if this is null. */
  soloStoreyExpressId: number | null;
  /** Per-storey gap in metres for Exploded. Default 4 m. */
  explodedGap: number;
  /**
   * Bookkeeping — last applied Y offset per storey, per model.
   * Read by the effect to compute deltas without re-doing the
   * "what was the previous gap?" math; written by the effect
   * after each successful flush. Tests can probe this directly.
   */
  appliedStoreyOffsets: AppliedStoreyOffsets;

  setLevelDisplayMode: (mode: LevelDisplayMode) => void;
  setSoloStoreyExpressId: (id: number | null) => void;
  setExplodedGap: (metres: number) => void;
  /** Effect-only: record the offsets that were just flushed to
   * the renderer so the next toggle knows what to subtract. */
  setAppliedStoreyOffsets: (next: AppliedStoreyOffsets) => void;
}

const LEVEL_DISPLAY_DEFAULTS = {
  mode: 'stacked' as LevelDisplayMode,
  gap: 4,
  soloStoreyExpressId: null as number | null,
};

export const createLevelDisplaySlice: StateCreator<LevelDisplaySlice, [], [], LevelDisplaySlice> = (set) => ({
  levelDisplayMode: LEVEL_DISPLAY_DEFAULTS.mode,
  soloStoreyExpressId: LEVEL_DISPLAY_DEFAULTS.soloStoreyExpressId,
  explodedGap: LEVEL_DISPLAY_DEFAULTS.gap,
  appliedStoreyOffsets: new Map(),

  setLevelDisplayMode: (levelDisplayMode) => set({ levelDisplayMode }),
  setSoloStoreyExpressId: (soloStoreyExpressId) => set({ soloStoreyExpressId }),
  setExplodedGap: (metres) => {
    // Guard against non-finite / non-positive — UI lets the user
    // type, but a 0 gap means "Exploded = Stacked" and a negative
    // gap inverts the sort, which is rarely useful. Clamp to
    // [0, 100] to keep behaviour sane.
    const clamped = Math.max(0, Math.min(100, Number.isFinite(metres) ? metres : 0));
    set({ explodedGap: clamped });
  },
  setAppliedStoreyOffsets: (appliedStoreyOffsets) => set({ appliedStoreyOffsets }),
});
