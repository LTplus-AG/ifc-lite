/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StateCreator } from 'zustand';
import type { SourceTag } from '@ifc-lite/plugin-api';

export interface SourcesSlice {
  sourcesPanelVisible: boolean;
  setSourcesPanelVisible: (visible: boolean) => void;
  toggleSourcesPanel: () => void;

  /** Provenance tags for models loaded from a cloud source, keyed by model id.
   *  Written when a source download finishes loading; removed by
   *  `modelSlice.removeModel` (cross-slice) so tags can never outlive their
   *  model, and cleared wholesale by `clearAllModels`. */
  sourceTags: Map<string, SourceTag>;
  setSourceTag: (modelId: string, tag: SourceTag) => void;
  removeSourceTag: (modelId: string) => void;
  clearSourceTags: () => void;
}

export const createSourcesSlice: StateCreator<
  SourcesSlice,
  [],
  [],
  SourcesSlice
> = (set) => ({
  sourcesPanelVisible: false,
  setSourcesPanelVisible: (sourcesPanelVisible) => set({ sourcesPanelVisible }),
  toggleSourcesPanel: () =>
    set((state) => ({ sourcesPanelVisible: !state.sourcesPanelVisible })),

  sourceTags: new Map(),
  setSourceTag: (modelId, tag) =>
    set((state) => {
      const next = new Map(state.sourceTags);
      next.set(modelId, tag);
      return { sourceTags: next };
    }),
  removeSourceTag: (modelId) =>
    set((state) => {
      if (!state.sourceTags.has(modelId)) return {};
      const next = new Map(state.sourceTags);
      next.delete(modelId);
      return { sourceTags: next };
    }),
  clearSourceTags: () =>
    set((state) => (state.sourceTags.size === 0 ? {} : { sourceTags: new Map() })),
});
