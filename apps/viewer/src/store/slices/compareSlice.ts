/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model-comparison panel state (issue #924). Holds the panel's UI state, the
 * A/B model selection, the data-vs-geometry scope, and the last `@ifc-lite/diff`
 * result. The orchestration (building per-entity fingerprints from each model's
 * `IfcDataStore` + geometry hashes, running `diffModels`, applying the 3D
 * colour/visibility overlay) lives in the `useCompare` hook — this slice is
 * deliberately dumb, mirroring `clashSlice` + `useClash`.
 */

import type { StateCreator } from 'zustand';
import type { DiffScope, ModelDiff } from '@ifc-lite/diff';
import type { CompareRef } from '@/lib/compare/buildFingerprints';

/** A completed comparison: the engine result plus the A/B context it ran on. */
export interface CompareResult {
  /** Federation model id chosen as the base (version A). */
  baseModelId: string;
  /** Federation model id chosen as the head (version B). */
  headModelId: string;
  /** Display name of the base model. */
  baseName: string;
  /** Display name of the head model. */
  headName: string;
  /** The scope the diff was computed with. */
  scope: DiffScope;
  /** True when a compared model carries no geometry hashes (loaded outside the
   *  WASM mesh path), so geometry-scope changes can't be detected. */
  geometryUnavailable: boolean;
  /** The engine output — entries keyed by GlobalId, with per-entity refs. */
  diff: ModelDiff<CompareRef>;
}

export interface CompareSlice {
  comparePanelVisible: boolean;
  /** Selected base (A) / head (B) federation model ids. */
  compareBaseModelId: string | null;
  compareHeadModelId: string | null;
  /** What counts as a change: data, geometry, or both. */
  compareScope: DiffScope;
  /** Whether unchanged elements are drawn (ghosted) or hidden. */
  compareShowUnchanged: boolean;
  /** Last comparison result (null when idle / not yet run). */
  compareResult: CompareResult | null;
  compareRunning: boolean;
  compareError: string | null;
  /** GlobalId of the entry focused in the list (for highlight). */
  compareSelectedKey: string | null;

  setComparePanelVisible: (visible: boolean) => void;
  toggleComparePanel: () => void;
  setCompareBaseModelId: (id: string | null) => void;
  setCompareHeadModelId: (id: string | null) => void;
  setCompareScope: (scope: DiffScope) => void;
  setCompareShowUnchanged: (show: boolean) => void;
  setCompareResult: (result: CompareResult | null) => void;
  setCompareRunning: (running: boolean) => void;
  setCompareError: (error: string | null) => void;
  setCompareSelectedKey: (key: string | null) => void;
  /** Clear the run result + selection; keeps the A/B + scope choices. */
  clearCompare: () => void;
}

export const createCompareSlice: StateCreator<CompareSlice, [], [], CompareSlice> = (set) => ({
  comparePanelVisible: false,
  compareBaseModelId: null,
  compareHeadModelId: null,
  compareScope: 'both',
  compareShowUnchanged: false,
  compareResult: null,
  compareRunning: false,
  compareError: null,
  compareSelectedKey: null,

  setComparePanelVisible: (comparePanelVisible) => set({ comparePanelVisible }),
  toggleComparePanel: () => set((s) => ({ comparePanelVisible: !s.comparePanelVisible })),
  setCompareBaseModelId: (compareBaseModelId) => set({ compareBaseModelId }),
  setCompareHeadModelId: (compareHeadModelId) => set({ compareHeadModelId }),
  setCompareScope: (compareScope) => set({ compareScope }),
  setCompareShowUnchanged: (compareShowUnchanged) => set({ compareShowUnchanged }),
  setCompareResult: (compareResult) => set({ compareResult }),
  setCompareRunning: (compareRunning) => set({ compareRunning }),
  setCompareError: (compareError) => set({ compareError }),
  setCompareSelectedKey: (compareSelectedKey) => set({ compareSelectedKey }),

  clearCompare: () =>
    set({
      compareResult: null,
      compareRunning: false,
      compareError: null,
      compareSelectedKey: null,
    }),
});
