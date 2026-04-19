/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Section plane state slice
 */

import type { StateCreator } from 'zustand';
import type { SectionPlane, SectionPlaneAxis, SectionCapStyle } from '../types.js';
import { SECTION_PLANE_DEFAULTS, SECTION_CAP_DEFAULTS } from '../constants.js';

export interface SectionSlice {
  // State
  sectionPlane: SectionPlane;

  // Actions
  setSectionPlaneAxis: (axis: SectionPlaneAxis) => void;
  setSectionPlanePosition: (position: number) => void;
  toggleSectionPlane: () => void;
  setSectionPlaneEnabled: (enabled: boolean) => void;
  flipSectionPlane: () => void;
  setSectionShowCap: (show: boolean) => void;
  setSectionCapStyle: (style: Partial<SectionCapStyle>) => void;
  resetSectionPlane: () => void;
}

const getDefaultCapStyle = (): SectionCapStyle => ({
  fillColor:   [...SECTION_CAP_DEFAULTS.FILL_COLOR],
  strokeColor: [...SECTION_CAP_DEFAULTS.STROKE_COLOR],
  pattern:     SECTION_CAP_DEFAULTS.PATTERN,
  spacingPx:   SECTION_CAP_DEFAULTS.SPACING_PX,
  angleRad:    SECTION_CAP_DEFAULTS.ANGLE_RAD,
  widthPx:     SECTION_CAP_DEFAULTS.WIDTH_PX,
  secondaryAngleRad: SECTION_CAP_DEFAULTS.SECONDARY_ANGLE_RAD,
});

const getDefaultSectionPlane = (): SectionPlane => ({
  axis: SECTION_PLANE_DEFAULTS.AXIS,
  position: SECTION_PLANE_DEFAULTS.POSITION,
  enabled: SECTION_PLANE_DEFAULTS.ENABLED,
  flipped: SECTION_PLANE_DEFAULTS.FLIPPED,
  showCap: SECTION_PLANE_DEFAULTS.SHOW_CAP,
  capStyle: getDefaultCapStyle(),
});

export const createSectionSlice: StateCreator<SectionSlice, [], [], SectionSlice> = (set) => ({
  // Initial state
  sectionPlane: getDefaultSectionPlane(),

  // Actions
  setSectionPlaneAxis: (axis) => set((state) => ({
    // Changing the axis implicitly means "I want to cut now" — enable the clip
    // so users don't get stuck in a confusing no-op preview.
    sectionPlane: { ...state.sectionPlane, axis, enabled: true },
  })),

  setSectionPlanePosition: (position) => set((state) => {
    // Clamp position to valid range [0, 100]
    const clampedPosition = Math.min(100, Math.max(0, Number(position) || 0));
    return {
      // Moving the slider also enables the cut — previously you had to press
      // "Cutting" separately, which led to the "it just jitters, doesn't cut"
      // feedback from users.
      sectionPlane: { ...state.sectionPlane, position: clampedPosition, enabled: true },
    };
  }),

  toggleSectionPlane: () => set((state) => ({
    sectionPlane: { ...state.sectionPlane, enabled: !state.sectionPlane.enabled },
  })),

  setSectionPlaneEnabled: (enabled) => set((state) => ({
    sectionPlane: { ...state.sectionPlane, enabled },
  })),

  flipSectionPlane: () => set((state) => ({
    sectionPlane: { ...state.sectionPlane, flipped: !state.sectionPlane.flipped },
  })),

  setSectionShowCap: (showCap) => set((state) => ({
    sectionPlane: { ...state.sectionPlane, showCap },
  })),

  setSectionCapStyle: (style) => set((state) => ({
    sectionPlane: { ...state.sectionPlane, capStyle: { ...state.sectionPlane.capStyle, ...style } },
  })),

  resetSectionPlane: () => set({ sectionPlane: getDefaultSectionPlane() }),
});
