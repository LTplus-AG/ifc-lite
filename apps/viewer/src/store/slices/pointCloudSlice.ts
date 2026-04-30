/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Point cloud rendering preferences (color mode, fixed override).
 *
 * The renderer reads these via `usePointCloudRenderOptionsSync`; UI
 * components write them via the actions below.
 */

import type { StateCreator } from 'zustand';

export type PointColorModeUi = 'rgb' | 'classification' | 'intensity' | 'height' | 'fixed';

export interface PointCloudSlice {
  pointCloudColorMode: PointColorModeUi;
  pointCloudFixedColor: [number, number, number, number];
  /**
   * Best-effort count of point cloud assets currently uploaded to the
   * renderer. Updated by ingest paths (IFCx + LAS/LAZ streaming). The
   * UI uses it to show/hide the controls panel.
   */
  pointCloudAssetCount: number;
  setPointCloudColorMode: (mode: PointColorModeUi) => void;
  setPointCloudFixedColor: (rgba: [number, number, number, number]) => void;
  setPointCloudAssetCount: (count: number) => void;
  incrementPointCloudAssetCount: (n?: number) => void;
}

export const createPointCloudSlice: StateCreator<PointCloudSlice, [], [], PointCloudSlice> = (set) => ({
  pointCloudColorMode: 'rgb',
  pointCloudFixedColor: [1, 1, 1, 1],
  pointCloudAssetCount: 0,
  setPointCloudColorMode: (mode) => set({ pointCloudColorMode: mode }),
  setPointCloudFixedColor: (rgba) => set({ pointCloudFixedColor: rgba }),
  setPointCloudAssetCount: (count) => set({ pointCloudAssetCount: Math.max(0, count) }),
  incrementPointCloudAssetCount: (n = 1) => set((s) => ({
    pointCloudAssetCount: Math.max(0, s.pointCloudAssetCount + n),
  })),
});
