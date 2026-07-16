/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Layer-stack panel state (issue #1717, Layer PRs viewer integration V1).
 *
 * Holds the ordered IFCX layer stack behind the current federated
 * composition — each entry keeps the parsed layer document (the federation
 * parser retains it anyway) plus a provenance summary for the panel — and
 * the last per-layer stack diff. Orchestration (running `diffLayerStacks`,
 * translating paths to selections) lives in `useLayerStack`; this slice is
 * deliberately dumb, mirroring `compareSlice` + `useCompare`.
 *
 * NOT related to the `mergeLayers` ui state, which is the multilayer-WALL
 * geometry feature.
 */

import type { StateCreator } from 'zustand';
import type { IfcxFile } from '@ifc-lite/ifcx';
import type { StackDiff } from '@ifc-lite/merge';

/** Provenance manifest author kinds (03-provenance.md). */
export type LayerAuthorKind = 'human' | 'agent' | 'hybrid';

/** One stratum of the loaded stack, weakest first (composition order). */
export interface LayerStackEntry {
  /** LayerStack id from the federation parser (stable for this session). */
  id: string;
  /** Display name (usually the file name). */
  name: string;
  /** The parsed layer document — the diff engine consumes these directly. */
  file: IfcxFile;
  /** Content address when the layer is blake3-addressed (published layers). */
  contentId?: string;
  /** Opinion-carrying nodes in this layer. */
  nodeCount: number;
  byteLength: number;
  /** Provenance summary, when the layer carries a manifest. */
  authorKind?: LayerAuthorKind;
  authorPrincipal?: string;
  intent?: string;
  created?: string;
  /** True when the manifest records a merge (this is a merge layer). */
  isMerge?: boolean;
  /** Check evidence attached to the manifest: passed / total. */
  checksPassed?: number;
  checksTotal?: number;
}

/** A computed per-layer contribution diff: prefix-below vs prefix-including. */
export interface LayerStackDiffResult {
  /** The entry whose contribution the diff isolates. */
  layerId: string;
  diff: StackDiff;
}

export interface LayerStackSlice {
  /**
   * The IFCX layers behind the current composition, weakest first. Empty
   * for non-federated (STEP / single-file / GLB) models.
   */
  layerStack: LayerStackEntry[];
  /** path → expressId for the current composition (3D selection bridge). */
  layerStackPathToId: Map<string, number> | null;
  /** Which layer's contribution diff is shown, or null. */
  layerStackDiff: LayerStackDiffResult | null;
  /** True while a diff is being computed (main thread, yielded). */
  layerDiffBusy: boolean;
  /** Docked-sidebar visibility flag (single-tenant slot, see SIDEBAR_PANEL_FLAGS). */
  layersPanelVisible: boolean;

  setLayersPanelVisible: (visible: boolean) => void;
  setLayerStack: (entries: LayerStackEntry[], pathToId: Map<string, number> | null) => void;
  clearLayerStack: () => void;
  setLayerStackDiff: (result: LayerStackDiffResult | null) => void;
  setLayerDiffBusy: (busy: boolean) => void;
}

export const createLayerStackSlice: StateCreator<LayerStackSlice, [], [], LayerStackSlice> = (
  set,
) => ({
  layerStack: [],
  layerStackPathToId: null,
  layerStackDiff: null,
  layerDiffBusy: false,
  layersPanelVisible: false,

  setLayersPanelVisible: (visible) => set({ layersPanelVisible: visible }),

  setLayerStack: (entries, pathToId) =>
    set({ layerStack: entries, layerStackPathToId: pathToId, layerStackDiff: null }),
  clearLayerStack: () =>
    set({ layerStack: [], layerStackPathToId: null, layerStackDiff: null, layerDiffBusy: false }),
  setLayerStackDiff: (result) => set({ layerStackDiff: result }),
  setLayerDiffBusy: (busy) => set({ layerDiffBusy: busy }),
});
