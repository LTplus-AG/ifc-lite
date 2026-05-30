/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Clash detection panel state (Phase 1). Detection itself lives in
 * `@ifc-lite/clash`; this slice holds the panel's UI state and the last result.
 * Orchestration (gathering elements, running the engine, applying colors /
 * selection / camera, BCF export) lives in the `useClash` hook.
 */

import type { StateCreator } from 'zustand';
import type { ClashResult, ClashGroup, ClashMode } from '@ifc-lite/clash';

export type ClashGroupBy = 'severity' | 'rule' | 'typePair';

export interface ClashSlice {
  clashPanelVisible: boolean;
  clashResult: ClashResult | null;
  clashGroups: ClashGroup[] | null;
  clashRunning: boolean;
  clashError: string | null;
  /** Detection settings. */
  clashMode: ClashMode;
  clashTolerance: number;
  clashClearance: number;
  /** How the result list is organized. */
  clashGroupBy: ClashGroupBy;
  /** Currently focused clash id (for highlight in the list). */
  clashSelectedId: string | null;

  setClashPanelVisible: (visible: boolean) => void;
  toggleClashPanel: () => void;
  setClashResult: (result: ClashResult | null) => void;
  setClashGroups: (groups: ClashGroup[] | null) => void;
  setClashRunning: (running: boolean) => void;
  setClashError: (error: string | null) => void;
  setClashMode: (mode: ClashMode) => void;
  setClashTolerance: (tolerance: number) => void;
  setClashClearance: (clearance: number) => void;
  setClashGroupBy: (groupBy: ClashGroupBy) => void;
  setClashSelectedId: (id: string | null) => void;
  clearClash: () => void;
}

export const createClashSlice: StateCreator<ClashSlice, [], [], ClashSlice> = (set) => ({
  clashPanelVisible: false,
  clashResult: null,
  clashGroups: null,
  clashRunning: false,
  clashError: null,
  clashMode: 'hard',
  clashTolerance: 0.002,
  clashClearance: 0.05,
  clashGroupBy: 'severity',
  clashSelectedId: null,

  setClashPanelVisible: (clashPanelVisible) => set({ clashPanelVisible }),
  toggleClashPanel: () => set((s) => ({ clashPanelVisible: !s.clashPanelVisible })),
  setClashResult: (clashResult) => set({ clashResult }),
  setClashGroups: (clashGroups) => set({ clashGroups }),
  setClashRunning: (clashRunning) => set({ clashRunning }),
  setClashError: (clashError) => set({ clashError }),
  setClashMode: (clashMode) => set({ clashMode }),
  setClashTolerance: (clashTolerance) => set({ clashTolerance }),
  setClashClearance: (clashClearance) => set({ clashClearance }),
  setClashGroupBy: (clashGroupBy) => set({ clashGroupBy }),
  setClashSelectedId: (clashSelectedId) => set({ clashSelectedId }),
  clearClash: () =>
    set({
      clashResult: null,
      clashGroups: null,
      clashRunning: false,
      clashError: null,
      clashSelectedId: null,
    }),
});
