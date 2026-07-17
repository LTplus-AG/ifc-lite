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

/** Number of u32 words in the 256-bit LAS class-visibility mask. */
export const POINT_CLOUD_CLASS_MASK_WORDS = 8;

/** All 256 LAS classes visible — the mask's default state. */
export const ALL_POINT_CLOUD_CLASSES_VISIBLE: readonly number[] =
  Object.freeze(new Array<number>(POINT_CLOUD_CLASS_MASK_WORDS).fill(0xFFFFFFFF));

/** Per-class point counts for one point cloud asset (classId → count). */
export type PointCloudClassCounts = Readonly<Record<number, number>>;

/** True when `classId`'s bit is set in the 8-word visibility mask. */
export function isPointCloudClassVisible(mask: readonly number[], classId: number): boolean {
  if (!Number.isInteger(classId) || classId < 0 || classId > 255) return true;
  const word = mask[classId >> 5];
  // Words beyond the stored array default to visible.
  if (!Number.isFinite(word)) return true;
  return ((word >>> (classId & 31)) & 1) !== 0;
}

/** Coerce arbitrary input into a well-formed 8-word unsigned mask. */
function sanitizeClassMaskWords(words: readonly number[]): number[] {
  const out = new Array<number>(POINT_CLOUD_CLASS_MASK_WORDS).fill(0xFFFFFFFF);
  for (let i = 0; i < POINT_CLOUD_CLASS_MASK_WORDS && i < words.length; i++) {
    const w = words[i];
    // Non-finite words reset to "all on" — same policy as the old
    // 32-bit setter; invalid input must never reach GPU uniforms.
    if (Number.isFinite(w)) out[i] = w >>> 0;
  }
  return out;
}

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
   * Per-LAS-class visibility bitmask covering the full 0..255 code
   * range, packed as 8 unsigned 32-bit words LSB-first (#1783). Bit
   * `i % 32` of word `i / 32` set → class `i` visible. Defaults to
   * everything visible. Only point clouds carry classifications;
   * meshes ignore this.
   */
  pointCloudClassMask: readonly number[];
  /**
   * Per-asset classification histograms, keyed by the renderer's
   * streamed-asset handle id (stringified) or `'ifcx'` for the merged
   * inline IFCx assets. Aggregated across assets by the classes UI so
   * the checklist only lists codes actually present in loaded scans,
   * with point counts (#1783).
   */
  pointCloudClassCounts: Readonly<Record<string, PointCloudClassCounts>>;
  /**
   * Stride-cull factor for the splat shader. 1 = render every point,
   * N>1 = render every Nth point. Used by the section-plane slider's
   * drag-preview path so dragging over a 100M-point scan stays
   * responsive. Defaults to 1 (full density).
   */
  pointCloudPreviewStride: number;
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
  setPointCloudClassMask: (mask: readonly number[]) => void;
  /** Toggle a single LAS class. `classId` is clamped to 0..255. */
  togglePointCloudClass: (classId: number) => void;
  /**
   * Record (or with `null`, drop) the classification histogram for one
   * asset. `key` is the renderer handle id for streamed scans or
   * `'ifcx'` for the merged inline assets.
   */
  setPointCloudClassCounts: (key: string | number, counts: Record<number, number> | null) => void;
  /** Set the stride-cull factor (1 = full density). */
  setPointCloudPreviewStride: (stride: number) => void;
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
  pointCloudClassMask: ALL_POINT_CLOUD_CLASSES_VISIBLE,
  pointCloudClassCounts: {} as Readonly<Record<string, PointCloudClassCounts>>,
  pointCloudPreviewStride: 1,
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
  setPointCloudClassMask: (mask) => set({
    pointCloudClassMask: sanitizeClassMaskWords(mask),
  }),
  togglePointCloudClass: (classId) => set((s) => {
    const c = Math.max(0, Math.min(255, classId | 0));
    const words = sanitizeClassMaskWords(s.pointCloudClassMask);
    // XOR flips the bit; coerce through `>>> 0` so the stored word
    // stays in the unsigned 32-bit range.
    words[c >> 5] = (words[c >> 5] ^ (1 << (c & 31))) >>> 0;
    return { pointCloudClassMask: words };
  }),
  setPointCloudClassCounts: (key, counts) => set((s) => {
    const k = String(key);
    if (counts === null) {
      if (!(k in s.pointCloudClassCounts)) return {};
      const next = { ...s.pointCloudClassCounts };
      delete next[k];
      return { pointCloudClassCounts: next };
    }
    return { pointCloudClassCounts: { ...s.pointCloudClassCounts, [k]: counts } };
  }),
  setPointCloudPreviewStride: (stride) => set({
    pointCloudPreviewStride: Number.isFinite(stride)
      ? Math.max(1, Math.min(256, Math.floor(stride) || 1))
      : 1,
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
