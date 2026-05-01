/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Point cloud rendering preferences.
 *
 * The renderer reads these via `usePointCloudSync`; UI components write
 * them via the actions below. EDL is opt-in (default on) — costs ~5
 * extra texture taps per pixel.
 */

import type { StateCreator } from 'zustand';

export type PointColorModeUi = 'rgb' | 'classification' | 'intensity' | 'height' | 'fixed' | 'deviation';
export type PointSizeModeUi = 'fixed-px' | 'adaptive-world' | 'attenuated';

export interface PointCloudSlice {
  pointCloudColorMode: PointColorModeUi;
  pointCloudFixedColor: [number, number, number, number];
  /** Splat sizing strategy. Default: 'fixed-px' (sized by the px slider). */
  pointCloudSizeMode: PointSizeModeUi;
  /** Splat size in pixels (fixed/attenuated) or upper cap (attenuated). 1..20. */
  pointCloudPointSize: number;
  /** World-space splat radius in metres for adaptive/attenuated modes.
   *  Typical scans: 0.005–0.05. Default 0.02. */
  pointCloudWorldRadius: number;
  /** Render splats as discs vs squares. Default true. */
  pointCloudRoundShape: boolean;
  /** Enable Eye-Dome Lighting post-pass. Default true. */
  pointCloudEdlEnabled: boolean;
  /** EDL strength multiplier. 0..3, default 1. */
  pointCloudEdlStrength: number;
  /**
   * BIM↔scan deviation heatmap range. `centerOffset` shifts the
   * "white" point off zero (handy when a scan has a global offset
   * from the model); `halfRange` is the metres mapped to ±1 on the
   * blue-white-red ramp. Defaults to (0, 0.05) — ±5cm.
   */
  pointCloudDeviationCenterOffset: number;
  pointCloudDeviationHalfRange: number;
  /**
   * True once `Renderer.computeDeviations` has populated the deviation
   * buffers for the current point cloud + mesh set. UI gates the
   * "Deviation" colour-mode option on this flag so users don't get a
   * confusing all-blue rendering when nothing has been computed.
   */
  pointCloudDeviationComputed: boolean;
  /**
   * Best-effort count of point cloud assets currently uploaded to the
   * renderer. Updated by ingest paths; UI uses it to show/hide the
   * controls panel and the EDL post-pass.
   */
  pointCloudAssetCount: number;
  setPointCloudColorMode: (mode: PointColorModeUi) => void;
  setPointCloudFixedColor: (rgba: [number, number, number, number]) => void;
  setPointCloudSizeMode: (mode: PointSizeModeUi) => void;
  setPointCloudPointSize: (px: number) => void;
  setPointCloudWorldRadius: (m: number) => void;
  setPointCloudRoundShape: (enabled: boolean) => void;
  setPointCloudEdlEnabled: (enabled: boolean) => void;
  setPointCloudEdlStrength: (strength: number) => void;
  setPointCloudDeviationCenterOffset: (m: number) => void;
  setPointCloudDeviationHalfRange: (m: number) => void;
  setPointCloudDeviationComputed: (computed: boolean) => void;
  setPointCloudAssetCount: (count: number) => void;
  incrementPointCloudAssetCount: (n?: number) => void;
}

/**
 * Single source of truth for the slice's runtime field defaults.
 * Both the slice initializer and `resetViewerState` consume this so
 * the two paths can't drift.
 */
export const POINT_CLOUD_DEFAULTS = {
  // Fixed-px is the default so the size slider feels responsive on first
  // contact. `attenuated` is nicer at extreme zooms but its "slider =
  // upper cap" semantic confuses users at typical wide views because the
  // projected world radius sits well below the cap.
  pointCloudColorMode: 'rgb' as PointColorModeUi,
  pointCloudFixedColor: [1, 1, 1, 1] as [number, number, number, number],
  pointCloudSizeMode: 'fixed-px' as PointSizeModeUi,
  pointCloudPointSize: 4,
  pointCloudWorldRadius: 0.02,
  pointCloudRoundShape: true,
  pointCloudEdlEnabled: true,
  pointCloudEdlStrength: 1,
  pointCloudDeviationCenterOffset: 0,
  pointCloudDeviationHalfRange: 0.05,
  pointCloudDeviationComputed: false,
  pointCloudAssetCount: 0,
} as const;

export const createPointCloudSlice: StateCreator<PointCloudSlice, [], [], PointCloudSlice> = (set) => ({
  ...POINT_CLOUD_DEFAULTS,
  // Re-spread typed-array fields so consumers get fresh references
  // instead of the readonly literal in POINT_CLOUD_DEFAULTS.
  pointCloudFixedColor: [...POINT_CLOUD_DEFAULTS.pointCloudFixedColor] as [number, number, number, number],
  setPointCloudColorMode: (mode) => set({ pointCloudColorMode: mode }),
  setPointCloudFixedColor: (rgba) => set({ pointCloudFixedColor: rgba }),
  setPointCloudSizeMode: (mode) => set({ pointCloudSizeMode: mode }),
  // NaN/Infinity slip past Math.max+min unchanged ((NaN < x) === false),
  // so guard with isFinite to keep invalid values out of GPU uniforms.
  setPointCloudPointSize: (px) => set({
    pointCloudPointSize: Number.isFinite(px) ? Math.max(1, Math.min(20, px)) : 4,
  }),
  setPointCloudWorldRadius: (m) => set({
    pointCloudWorldRadius: Number.isFinite(m) ? Math.max(1e-4, m) : 0.02,
  }),
  setPointCloudRoundShape: (enabled) => set({ pointCloudRoundShape: enabled }),
  setPointCloudEdlEnabled: (enabled) => set({ pointCloudEdlEnabled: enabled }),
  setPointCloudEdlStrength: (strength) => set({
    pointCloudEdlStrength: Number.isFinite(strength) ? Math.max(0, Math.min(3, strength)) : 1,
  }),
  setPointCloudDeviationCenterOffset: (m) => set({
    pointCloudDeviationCenterOffset: Number.isFinite(m) ? m : 0,
  }),
  setPointCloudDeviationHalfRange: (m) => set({
    // halfRange must stay strictly positive — a zero or negative value
    // would NaN the GPU ramp's division. Clamp to 0.1 mm minimum.
    pointCloudDeviationHalfRange: Number.isFinite(m) ? Math.max(1e-4, m) : 0.05,
  }),
  setPointCloudDeviationComputed: (computed) => set({ pointCloudDeviationComputed: computed }),
  setPointCloudAssetCount: (count) => set({
    pointCloudAssetCount: Number.isFinite(count) ? Math.max(0, count) : 0,
  }),
  incrementPointCloudAssetCount: (n = 1) => set((s) => ({
    pointCloudAssetCount: Number.isFinite(n)
      ? Math.max(0, s.pointCloudAssetCount + n)
      : s.pointCloudAssetCount,
  })),
});
