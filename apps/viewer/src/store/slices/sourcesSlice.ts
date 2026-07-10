/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StateCreator } from 'zustand';
import type { SourceTag } from '@ifc-lite/plugin-api';

export type SourceBrowserStep = 'providers' | 'projects' | 'containers' | 'files';

export interface SourceBrowserState {
  step: SourceBrowserStep;
  providerId?: string;
  projectId?: string;
  containerId?: string;
}

export interface SourcesSlice {
  sourcesPanelVisible: boolean;
  setSourcesPanelVisible: (visible: boolean) => void;
  toggleSourcesPanel: () => void;

  sourceBrowser: SourceBrowserState;
  setSourceBrowser: (state: SourceBrowserState) => void;
  resetSourceBrowser: () => void;

  sourceSettingsOpen: string | null;
  setSourceSettingsOpen: (providerId: string | null) => void;

  sourceConnectionTesting: string | null;
  setSourceConnectionTesting: (providerId: string | null) => void;

  sourceTags: Map<string, SourceTag>;
  setSourceTag: (modelId: string, tag: SourceTag) => void;
  removeSourceTag: (modelId: string) => void;
}

const INITIAL_BROWSER: SourceBrowserState = { step: 'providers' };

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

  sourceBrowser: INITIAL_BROWSER,
  setSourceBrowser: (sourceBrowser) => set({ sourceBrowser }),
  resetSourceBrowser: () => set({ sourceBrowser: INITIAL_BROWSER }),

  sourceSettingsOpen: null,
  setSourceSettingsOpen: (sourceSettingsOpen) => set({ sourceSettingsOpen }),

  sourceConnectionTesting: null,
  setSourceConnectionTesting: (sourceConnectionTesting) =>
    set({ sourceConnectionTesting }),

  sourceTags: new Map(),
  setSourceTag: (modelId, tag) =>
    set((state) => {
      const next = new Map(state.sourceTags);
      next.set(modelId, tag);
      return { sourceTags: next };
    }),
  removeSourceTag: (modelId) =>
    set((state) => {
      const next = new Map(state.sourceTags);
      next.delete(modelId);
      return { sourceTags: next };
    }),
});
